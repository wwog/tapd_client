//! Durable free-chat sessions and message history.
//!
//! 会话元数据以 `ChatSession` JSON 存进 `chat_sessions.payload`，另外把
//! 项目 / 运行时 / 模型 / 状态 / 时间拆成索引列，供后续过滤与排序；消息
//! 以 `(chat_id, message_id)` 为唯一键 upsert，`chat_messages_fts` 支持
//! 中文子串搜索（trigram，>=3 字；短词由查询层回退 LIKE）。

use std::collections::HashSet;

use rusqlite::{params, params_from_iter, types::Value as SqlValue};
use serde::Serialize;

use super::{unix_now, Cache};
use crate::agent::{ChatMessage, ChatSession};

/// 会话列表过滤条件；字段为空表示不限制。
#[derive(Clone, Debug, Default)]
pub(crate) struct ChatSessionQuery {
    pub(crate) workspace_id: Option<String>,
    pub(crate) runtime_id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) status: Option<String>,
    /// 匹配标题 / 项目名。
    pub(crate) keyword: Option<String>,
    pub(crate) limit: Option<u32>,
    pub(crate) offset: Option<u32>,
}

/// 消息内容搜索条件。
#[derive(Clone, Debug, Default)]
pub(crate) struct ChatSearchQuery {
    pub(crate) keyword: String,
    pub(crate) workspace_id: Option<String>,
    pub(crate) runtime_id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) limit: Option<u32>,
}

/// 一条内容命中；前端据此定位会话并展示上下文片段。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSearchHit {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) workspace_name: String,
    pub(crate) message_id: String,
    pub(crate) role: String,
    pub(crate) at: String,
    pub(crate) snippet: String,
}

const SEARCH_LIMIT_DEFAULT: u32 = 50;
const SEARCH_LIMIT_MAX: u32 = 200;
const LIST_LIMIT_MAX: u32 = 500;

impl Cache {
    /// 按更新时间倒序加载全部会话；单行 JSON 损坏时跳过而不是丢掉整表。
    pub(crate) fn load_chat_sessions(&self) -> Option<Vec<ChatSession>> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT payload FROM chat_sessions ORDER BY updated_at DESC, rowid DESC")
                .ok()?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0)).ok()?;
            Some(
                rows.flatten()
                    .filter_map(|payload| serde_json::from_str::<ChatSession>(&payload).ok())
                    .collect(),
            )
        })
        .flatten()
    }

    /// 用内存中的完整列表同步 `chat_sessions`：upsert 现存会话，并删除已不在
    /// 列表里的会话及其消息。返回 `false` 表示 SQLite 不可用或写入失败。
    pub(crate) fn save_chat_sessions(&self, sessions: &[ChatSession]) -> bool {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return false;
        };
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            let existing: Vec<String> = {
                let mut statement = tx.prepare("SELECT id FROM chat_sessions")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                rows.flatten().collect()
            };
            {
                let mut statement = tx.prepare(
                    "INSERT INTO chat_sessions (
                        id, workspace_id, workspace_name, runtime_id, model, status,
                        title, created_at, updated_at, payload
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET
                        workspace_id = excluded.workspace_id,
                        workspace_name = excluded.workspace_name,
                        runtime_id = excluded.runtime_id,
                        model = excluded.model,
                        status = excluded.status,
                        title = excluded.title,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at,
                        payload = excluded.payload",
                )?;
                for session in sessions {
                    let payload = serde_json::to_string(session).unwrap_or_default();
                    statement.execute(params![
                        session.id,
                        session.workspace_id,
                        session.workspace_name,
                        session.runtime_id,
                        session.model,
                        session.status.key(),
                        session.title,
                        session.created_at,
                        session.updated_at,
                        payload,
                    ])?;
                }
            }

            let keep: HashSet<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
            let mut removed = false;
            for id in existing.iter().filter(|id| !keep.contains(id.as_str())) {
                tx.execute("DELETE FROM chat_sessions WHERE id = ?1", [id])?;
                // 没有外键：删除会话时显式清理消息，FTS 触发器会同步索引。
                tx.execute("DELETE FROM chat_messages WHERE chat_id = ?1", [id])?;
                removed = true;
            }
            if removed {
                // 删除瞬间仍在解析的 transcript 可能迟到写入一条孤儿消息。
                tx.execute(
                    "DELETE FROM chat_messages
                      WHERE chat_id NOT IN (SELECT id FROM chat_sessions)",
                    [],
                )?;
            }
            tx.commit()
        })();
        if let Err(error) = &result {
            tracing::warn!(%error, "failed to save chat sessions");
        }
        result.is_ok()
    }

    /// 批量写入一条会话的消息；相同 `message_id` 的内容变化时更新原行
    /// （工具结果回填），rowid 保持不变以维持消息顺序。
    pub(crate) fn upsert_chat_messages(&self, chat_id: &str, messages: &[ChatMessage]) -> bool {
        if messages.is_empty() {
            return true;
        }
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return false;
        };
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            {
                let mut statement = tx.prepare(
                    "INSERT INTO chat_messages (
                        chat_id, message_id, role, kind, at, text, payload, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(chat_id, message_id) DO UPDATE SET
                        role = excluded.role,
                        kind = excluded.kind,
                        at = excluded.at,
                        text = excluded.text,
                        payload = excluded.payload,
                        updated_at = excluded.updated_at
                     WHERE chat_messages.payload <> excluded.payload",
                )?;
                let now = unix_now();
                for message in messages {
                    let payload = serde_json::to_string(message).unwrap_or_default();
                    statement.execute(params![
                        chat_id,
                        message.id,
                        message.role,
                        message.kind,
                        message.at,
                        message.text.as_deref().unwrap_or(""),
                        payload,
                        now,
                    ])?;
                }
            }
            tx.commit()
        })();
        if let Err(error) = &result {
            tracing::warn!(%error, "failed to save chat messages");
        }
        result.is_ok()
    }

    /// 读取本地保存的消息历史（按首次写入顺序）。
    pub(crate) fn load_chat_messages(&self, chat_id: &str) -> Option<Vec<ChatMessage>> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT payload FROM chat_messages WHERE chat_id = ?1 ORDER BY id ASC")
                .ok()?;
            let rows = statement
                .query_map([chat_id], |row| row.get::<_, String>(0))
                .ok()?;
            Some(
                rows.flatten()
                    .filter_map(|payload| serde_json::from_str::<ChatMessage>(&payload).ok())
                    .collect(),
            )
        })
        .flatten()
    }

    /// 按项目 / 运行时 / 模型 / 状态过滤会话；无过滤时返回全部（保持旧行为）。
    pub(crate) fn query_chat_sessions(
        &self,
        query: &ChatSessionQuery,
    ) -> Option<Vec<ChatSession>> {
        self.with_conn(|conn| {
            let mut sql = String::from("SELECT payload FROM chat_sessions WHERE 1 = 1");
            let mut args: Vec<SqlValue> = Vec::new();
            for (column, value) in [
                ("workspace_id", &query.workspace_id),
                ("runtime_id", &query.runtime_id),
                ("model", &query.model),
                ("status", &query.status),
            ] {
                if let Some(value) = non_empty(value.as_deref()) {
                    sql.push_str(&format!(" AND {column} = ?"));
                    args.push(SqlValue::Text(value.to_string()));
                }
            }
            if let Some(keyword) = non_empty(query.keyword.as_deref()) {
                sql.push_str(" AND (title LIKE ? ESCAPE '\\' OR workspace_name LIKE ? ESCAPE '\\')");
                let like = format!("%{}%", escape_like(keyword));
                args.push(SqlValue::Text(like.clone()));
                args.push(SqlValue::Text(like));
            }
            sql.push_str(" ORDER BY updated_at DESC, rowid DESC");

            let limit = query.limit.map(|value| value.min(LIST_LIMIT_MAX));
            match (limit, query.offset) {
                (Some(limit), offset) if limit > 0 => {
                    sql.push_str(" LIMIT ?");
                    args.push(SqlValue::Integer(limit as i64));
                    if let Some(offset) = offset.filter(|value| *value > 0) {
                        sql.push_str(" OFFSET ?");
                        args.push(SqlValue::Integer(offset as i64));
                    }
                }
                (_, Some(offset)) if offset > 0 => {
                    // 只有 offset 没有 limit：SQLite 需要显式 LIMIT -1。
                    sql.push_str(" LIMIT -1 OFFSET ?");
                    args.push(SqlValue::Integer(offset as i64));
                }
                _ => {}
            }

            let mut statement = conn.prepare(&sql).ok()?;
            let rows = statement
                .query_map(params_from_iter(args), |row| {
                    row.get::<_, String>(0)
                })
                .ok()?;
            Some(
                rows.flatten()
                    .filter_map(|payload| serde_json::from_str::<ChatSession>(&payload).ok())
                    .collect(),
            )
        })
        .flatten()
    }

    /// 在消息正文里搜索关键字。>=3 字（trigram 的最小词长）走 FTS，更短的
    /// 中文词（例如「登录」）回退 LIKE，避免索引无法命中。
    pub(crate) fn search_chat_messages(
        &self,
        query: &ChatSearchQuery,
    ) -> Option<Vec<ChatSearchHit>> {
        let keyword = query.keyword.trim();
        if keyword.is_empty() {
            return Some(Vec::new());
        }
        self.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT m.chat_id, s.title, s.workspace_name, m.message_id, m.role, m.at, m.text
                 FROM chat_messages m
                 JOIN chat_sessions s ON s.id = m.chat_id",
            );
            let mut args: Vec<SqlValue> = Vec::new();
            if keyword.chars().count() >= 3 {
                // FTS5 的 MATCH 左侧必须是表名，别名会报 no such column。
                sql.push_str(
                    " JOIN chat_messages_fts ON chat_messages_fts.rowid = m.id
                      WHERE chat_messages_fts MATCH ?",
                );
                args.push(SqlValue::Text(fts_query(keyword)));
            } else {
                sql.push_str(" WHERE m.text LIKE ? ESCAPE '\\'");
                args.push(SqlValue::Text(format!("%{}%", escape_like(keyword))));
            }
            for (column, value) in [
                ("s.workspace_id", &query.workspace_id),
                ("s.runtime_id", &query.runtime_id),
                ("s.model", &query.model),
            ] {
                if let Some(value) = non_empty(value.as_deref()) {
                    sql.push_str(&format!(" AND {column} = ?"));
                    args.push(SqlValue::Text(value.to_string()));
                }
            }
            let limit = query
                .limit
                .unwrap_or(SEARCH_LIMIT_DEFAULT)
                .min(SEARCH_LIMIT_MAX)
                .max(1);
            sql.push_str(" ORDER BY m.id DESC LIMIT ?");
            args.push(SqlValue::Integer(limit as i64));

            let mut statement = conn.prepare(&sql).ok()?;
            let rows = statement
                .query_map(params_from_iter(args), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .ok()?;
            Some(
                rows.flatten()
                    .map(
                        |(session_id, title, workspace_name, message_id, role, at, text)| {
                            ChatSearchHit {
                                session_id,
                                title,
                                workspace_name,
                                message_id,
                                role,
                                at,
                                snippet: hit_snippet(&text, keyword),
                            }
                        },
                    )
                    .collect(),
            )
        })
        .flatten()
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// 转义 LIKE 的通配符；SQL 侧统一使用 `ESCAPE '\'`。
fn escape_like(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            output.push('\\');
        }
        output.push(ch);
    }
    output
}

/// FTS5 查询串：整体加双引号，避免用户输入的 `AND` / `*` 等被当作语法。
fn fts_query(keyword: &str) -> String {
    format!("\"{}\"", keyword.replace('"', "\"\""))
}

/// 命中位置前后各截一段；按字符边界截断，中文不会被切坏。
fn hit_snippet(text: &str, keyword: &str) -> String {
    const BEFORE: usize = 40;
    const AFTER: usize = 60;

    let lower = text.to_lowercase();
    let needle = keyword.to_lowercase();
    let byte = lower.find(&needle).unwrap_or(0);
    // 大小写折叠理论上可能改变字节下标；落在非字符边界时退回开头。
    let byte = if text.is_char_boundary(byte) { byte } else { 0 };
    let position = text[..byte].chars().count();
    let chars: Vec<usize> = text.char_indices().map(|(index, _)| index).collect();
    let start = position.saturating_sub(BEFORE);
    let end = (position + keyword.chars().count() + AFTER).min(chars.len());
    let from = chars.get(start).copied().unwrap_or(0);
    let to = chars
        .get(end)
        .copied()
        .unwrap_or_else(|| text.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(&text[from..to]);
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_cache(label: &str) -> (Cache, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "tapd-chat-cache-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let path = dir.join("cache.sqlite3");
        (Cache::open(path.clone()), path)
    }

    fn session(id: &str, workspace: &str, runtime: &str, updated_at: &str) -> ChatSession {
        ChatSession {
            id: id.to_string(),
            workspace_id: workspace.to_string(),
            workspace_name: "项目".to_string(),
            repo_path: "/tmp/repo".to_string(),
            runtime_id: runtime.to_string(),
            model: "model-a".to_string(),
            permission_mode: String::new(),
            title: format!("标题 {id}"),
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            status: serde_json::from_str("\"stopped\"").expect("status"),
            agent_session_id: None,
            error: None,
            ready: false,
        }
    }

    fn message(id: &str, text: &str) -> ChatMessage {
        ChatMessage {
            id: id.to_string(),
            role: "assistant".to_string(),
            kind: "message".to_string(),
            at: "2026-01-01T00:00:00Z".to_string(),
            text: Some(text.to_string()),
            tool: None,
        }
    }

    #[test]
    fn sessions_round_trip_and_remove_missing_rows() {
        let (cache, path) = temp_cache("sessions");
        let first = session("a", "ws-1", "opencode", "2026-01-01T00:00:00Z");
        let second = session("b", "ws-2", "omp", "2026-01-02T00:00:00Z");
        assert!(cache.save_chat_sessions(&[first.clone(), second.clone()]));

        let loaded = cache.load_chat_sessions().expect("sqlite");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "b", "newest updated_at first");

        // 只保留 b：a 的会话行和消息都要被清理。
        assert!(cache.upsert_chat_messages("a", &[message("m1", "hi")]));
        assert!(cache.save_chat_sessions(&[second.clone()]));
        let loaded = cache.load_chat_sessions().expect("sqlite");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "b");
        assert!(
            cache
                .load_chat_messages("a")
                .expect("sqlite")
                .is_empty(),
            "removed session must drop its messages"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn message_upsert_keeps_order_and_updates_tool_payload() {
        let (cache, path) = temp_cache("messages");
        let chat = session("a", "ws-1", "opencode", "2026-01-01T00:00:00Z");
        assert!(cache.save_chat_sessions(&[chat]));

        assert!(cache.upsert_chat_messages(
            "a",
            &[message("m1", "你好"), message("m2", "世界")]
        ));
        // 同一个 message_id 内容变化（工具结果回填）应更新原行。
        assert!(cache.upsert_chat_messages("a", &[message("m2", "世界！")]));

        let loaded = cache.load_chat_messages("a").expect("sqlite");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].text.as_deref(), Some("你好"));
        assert_eq!(loaded[1].text.as_deref(), Some("世界！"));

        // FTS 触发器必须跟着 UPDATE 走，否则搜索会返回旧文本。
        let hits = cache
            .search_chat_messages(&ChatSearchQuery {
                keyword: "世界！".to_string(),
                ..ChatSearchQuery::default()
            })
            .expect("sqlite");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("世界！"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn session_filters_and_paging_apply() {
        let (cache, path) = temp_cache("filters");
        let sessions = [
            session("a", "ws-1", "opencode", "2026-01-03T00:00:00Z"),
            session("b", "ws-1", "omp", "2026-01-02T00:00:00Z"),
            session("c", "ws-2", "opencode", "2026-01-01T00:00:00Z"),
        ];
        assert!(cache.save_chat_sessions(&sessions));

        let query = ChatSessionQuery {
            workspace_id: Some("ws-1".to_string()),
            ..ChatSessionQuery::default()
        };
        let hits = cache.query_chat_sessions(&query).expect("sqlite");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "a");

        let query = ChatSessionQuery {
            runtime_id: Some("opencode".to_string()),
            limit: Some(1),
            ..ChatSessionQuery::default()
        };
        let hits = cache.query_chat_sessions(&query).expect("sqlite");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn keyword_search_uses_fts_or_like_and_respects_filters() {
        let (cache, path) = temp_cache("search");
        let sessions = [
            session("a", "ws-1", "opencode", "2026-01-02T00:00:00Z"),
            session("b", "ws-2", "omp", "2026-01-01T00:00:00Z"),
        ];
        assert!(cache.save_chat_sessions(&sessions));
        assert!(cache.upsert_chat_messages(
            "a",
            &[
                message("m1", "登录接口返回 401，需要排查鉴权"),
                message("m2", "今天天气不错"),
            ]
        ));
        assert!(cache.upsert_chat_messages(
            "b",
            &[message("m3", "登录失败")]
        ));

        // 3 字：走 FTS trigram。
        let hits = cache
            .search_chat_messages(&ChatSearchQuery {
                keyword: "登录接口".to_string(),
                ..ChatSearchQuery::default()
            })
            .expect("sqlite");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "a");
        assert!(hits[0].snippet.contains("登录接口"));
        assert_eq!(hits[0].title, "标题 a");

        // 2 字：回退 LIKE，能命中两个会话。
        let hits = cache
            .search_chat_messages(&ChatSearchQuery {
                keyword: "登录".to_string(),
                ..ChatSearchQuery::default()
            })
            .expect("sqlite");
        assert_eq!(hits.len(), 2);

        // 过滤条件参与搜索。
        let hits = cache
            .search_chat_messages(&ChatSearchQuery {
                keyword: "登录".to_string(),
                workspace_id: Some("ws-1".to_string()),
                ..ChatSearchQuery::default()
            })
            .expect("sqlite");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "a");

        let _ = std::fs::remove_file(path);
    }
}

//! 变更历史（`/ws/bugtrace/bugs/changes_list`）的解析。
//!
//! TAPD 的详情页把「变更历史」放在一个经典服务端渲染的微前端 tab 里，没有
//! JSON 接口，返回的是一整页 HTML。表格结构固定：
//!
//! ```html
//! <table class="... bug-history">
//!   <thead><tr><th>序号(5)</th>...</tr></thead>
//!   <tr>                          <!-- 一次变更 -->
//!     <td>1</td><td>时间</td><td>变更人</td><td>变更类型</td>
//!     <td colspan="3"><table>     <!-- 字段明细 -->
//!       <tr><td>字段</td><td>变更前</td><td>变更后</td></tr>
//!     </table></td>
//!   </tr>
//! </table>
//! ```
//!
//! 这里用一个很小的标签扫描器把两层表格读出来，不引入 DOM 依赖。

use crate::tapd::api::TAPD_BASE;
use crate::tapd::model::{ChangeEntry, ChangeField, ChangeHistory};

/// The legacy page returns at most 10 rows per request.
pub const CHANGES_PER_PAGE: u32 = 10;

pub fn changes_list_url(workspace_id: &str, bug_id: &str, page: u32) -> String {
    format!(
        "{TAPD_BASE}/{workspace_id}/bugtrace/bugs/changes_list?perpage={CHANGES_PER_PAGE}&page={}&bug_id={bug_id}&only_content=1&microapp=1",
        page.max(1)
    )
}

struct Row {
    depth: usize,
    from_th: bool,
    cells: Vec<String>,
}

/// Parses one `changes_list` page.
pub fn parse_changes_html(html: &str) -> Result<ChangeHistory, String> {
    if html.trim().is_empty() {
        return Err("empty changes_list response".to_string());
    }
    if !html.contains("bug-history") && !html.contains("changelogtable") {
        return Err("unexpected changes_list response (no history table)".to_string());
    }

    let mut depth = 0usize;
    let mut rows: Vec<Row> = Vec::new();
    let mut cell: Option<usize> = None;
    let mut changes: Vec<ChangeEntry> = Vec::new();
    // Field rows close before the change row that owns them, so they are
    // buffered here and attached when that row closes.
    let mut pending_fields: Vec<ChangeField> = Vec::new();

    let bytes = html.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] != b'<' {
            let end = html[index..].find('<').map(|offset| index + offset).unwrap_or(bytes.len());
            if let (Some(cell_index), Some(row)) = (cell, rows.last_mut()) {
                if row.depth == depth {
                    if let Some(target) = row.cells.get_mut(cell_index) {
                        target.push_str(&html[index..end]);
                    }
                }
            }
            index = end;
            continue;
        }

        let Some(end_offset) = html[index..].find('>') else {
            break;
        };
        let end = index + end_offset;
        let tag = &html[index..=end];
        let lower = tag.to_ascii_lowercase();
        let closing = lower.starts_with("</");
        let name = element_name(&lower);

        match (closing, name) {
            (false, "table") => depth += 1,
            (true, "table") => {
                depth = depth.saturating_sub(1);
                cell = None;
            }
            (false, "tr") => {
                if depth == 1 {
                    pending_fields.clear();
                }
                rows.push(Row {
                    depth,
                    from_th: false,
                    cells: Vec::new(),
                })
            }
            (true, "tr") => {
                if let Some(row) = rows.pop() {
                    match row.depth {
                        1 => {
                            if let Some(mut entry) = outer_row(&row) {
                                entry.fields = std::mem::take(&mut pending_fields);
                                changes.push(entry);
                            }
                        }
                        2 => {
                            if !row.from_th {
                                if let Some(field) = inner_row(&row) {
                                    pending_fields.push(field);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                cell = None;
            }
            (false, "td") | (false, "th") => {
                if let Some(row) = rows.last_mut() {
                    if row.depth == depth {
                        if name == "th" {
                            row.from_th = true;
                        }
                        row.cells.push(String::new());
                        cell = Some(row.cells.len() - 1);
                    }
                }
            }
            (true, "td") | (true, "th") => cell = None,
            (false, "img") => {
                if let (Some(cell_index), Some(row)) = (cell, rows.last_mut()) {
                    if row.depth == depth {
                        if let Some(target) = row.cells.get_mut(cell_index) {
                            target.push_str("[图片]");
                        }
                    }
                }
            }
            _ => {}
        }

        index = end + 1;
    }

    let total = total_count(html).unwrap_or(changes.len() as u32);

    Ok(ChangeHistory {
        total,
        changes,
        error: None,
    })
}

fn element_name(lower_tag: &str) -> &str {
    lower_tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .trim_start()
        .split(|character: char| {
            character.is_whitespace() || character == '>' || character == '/'
        })
        .next()
        .unwrap_or_default()
}

fn outer_row(row: &Row) -> Option<ChangeEntry> {
    if row.from_th || row.cells.len() < 4 {
        return None;
    }
    let seq = row.cells[0].trim().parse::<u32>().ok()?;

    Some(ChangeEntry {
        seq,
        time: clean(&row.cells[1]),
        author: clean(&row.cells[2]),
        kind: clean(&row.cells[3]),
        fields: Vec::new(),
    })
}

fn inner_row(row: &Row) -> Option<ChangeField> {
    if row.cells.len() < 3 {
        return None;
    }

    Some(ChangeField {
        field: clean(&row.cells[0]),
        before: clean(&row.cells[1]),
        after: clean(&row.cells[2]),
    })
}

fn total_count(html: &str) -> Option<u32> {
    for needle in ["var _revisionsCount = ", "序号("] {
        let Some(position) = html.find(needle) else {
            continue;
        };
        let digits: String = html[position + needle.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(value) = digits.parse::<u32>() {
            return Some(value);
        }
    }
    None
}

fn clean(value: &str) -> String {
    crate::tapd::api::collapse_whitespace(&crate::tapd::api::decode_entities(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
<script>var _revisionsCount = 2;</script>
<div id="changelogtable">
  <table class="table striped tfl-table table-history bug-history" width="100%">
    <thead>
      <tr>
        <th width="60">序号(2)</th>
        <th width="130">变更时间</th>
        <th width="auto">变更人</th>
        <th width="130">变更类型</th>
        <th colspan='3'>
          <table><tr>
            <td width="33%">变更字段</td><td width="33%">变更前</td><td width="34%">变更后</td>
          </tr></table>
        </th>
      </tr>
    </thead>
    <tr title_username class="">
      <td >1</td>
      <td width = '130'>2026-11-09 17:03:16</td>
      <td width = 'auto' style='white-space: nowrap;' title="郭俊宏">
        郭俊宏        </td>
      <td width = '110' title=手动变更>手动变更</td>
      <td colspan="3">
        <table>
          <tr title_username><td width = '33%'>处理人</td><td title='范艺;' width = '33%'>范艺;</td><td title='郭俊宏' width = '34%'>郭俊宏</td></tr>
        </table>
      </td>
    </tr>
    <tr title_username class="ie-tr-striped">
      <td >2</td>
      <td width = '130'>2026-11-09 17:03:05</td>
      <td width = 'auto' title="郭俊宏">郭俊宏</td>
      <td width = '110' title=手动变更>手动变更</td>
      <td colspan="3">
        <table>
          <tr title_username><td width = '33%'>状态</td><td width = '33%'>接受/处理</td><td width = '34%'>已解决</td></tr>
          <tr title_username><td width = '33%'>修复人</td><td width = '33%'>--</td><td width = '34%'>郭俊宏</td></tr>
          <tr title_username><td width = '33%'>附件</td><td width = '33%'>--</td><td width = '34%'><img src="/x.png"></td></tr>
        </table>
      </td>
    </tr>
  </table>
</div>
"#;

    #[test]
    fn parses_change_rows_and_fields() {
        let history = parse_changes_html(SAMPLE).expect("history");
        assert_eq!(history.total, 2);
        assert_eq!(history.changes.len(), 2);

        let first = &history.changes[0];
        assert_eq!(first.seq, 1);
        assert_eq!(first.time, "2026-11-09 17:03:16");
        assert_eq!(first.author, "郭俊宏");
        assert_eq!(first.kind, "手动变更");
        assert_eq!(first.fields.len(), 1);
        assert_eq!(first.fields[0].field, "处理人");
        assert_eq!(first.fields[0].before, "范艺;");
        assert_eq!(first.fields[0].after, "郭俊宏");

        let second = &history.changes[1];
        assert_eq!(second.fields.len(), 3);
        assert_eq!(second.fields[1].field, "修复人");
        assert_eq!(second.fields[2].before, "--");
        assert_eq!(second.fields[2].after, "[图片]");
    }

    #[test]
    fn finds_total_without_script_variable() {
        let html = SAMPLE.replace("var _revisionsCount = 2;", "");
        let history = parse_changes_html(&html).expect("history");
        assert_eq!(history.total, 2);
    }

    #[test]
    fn rejects_login_pages() {
        let html = "<html><body>请登录</body></html>";
        assert!(parse_changes_html(html).is_err());
    }

    #[test]
    fn builds_paged_url() {
        assert!(changes_list_url("45336192", "1010583", 2).ends_with(
            "/45336192/bugtrace/bugs/changes_list?perpage=10&page=2&bug_id=1010583&only_content=1&microapp=1"
        ));
    }
}

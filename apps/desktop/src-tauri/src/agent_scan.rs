//! 本机 Agent 安装检测与版本缓存。
//!
//! 只做两件事：
//! - 在用户 shell 的 `PATH` 里找运行时描述符声明的可执行文件（含别名）；
//! - 对找到的二进制跑一次 `--version`，把结果连同检测时间写入 `agent-scan.json`。
//!
//! 自动检测每天最多一次（启动时判断缓存是否过期），设置页可以手动强制刷新。
//! 检测只读，不会修改任何 Agent 配置。

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tapd_core::store::{read_json, write_json_atomic};

use crate::{
    agent::{resolve_executable, runtime_catalog, AgentRuntimeDescriptor},
    shell_path,
};

/// 检测结果文件，放在应用数据目录下。
pub const SCAN_FILE: &str = "agent-scan.json";
/// 自动检测周期：24 小时。
const SCAN_TTL_SECS: i64 = 24 * 60 * 60;
/// 单个 `--version` 的上限，和手动检测保持一致。
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
/// 同时探测的二进制数量；手动刷新时避免几十个进程一起抢 CPU。
const MAX_PARALLEL_PROBES: usize = 6;

/// 一个运行时的检测结果。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScanResult {
    pub runtime_id: String,
    pub name: String,
    /// 描述符里的默认命令，便于前端在未检测到时展示。
    pub binary: String,
    /// PATH 中解析到的绝对路径。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    /// `--version` 的首行输出。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub found: bool,
    /// 找到但版本探测失败时的原因。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentScanSnapshot {
    /// RFC3339 检测时间；为空表示从未检测过。
    pub checked_at: String,
    pub results: Vec<AgentScanResult>,
}

impl AgentScanSnapshot {
    /// 24 小时内视为新鲜，启动时不再重复扫描。
    pub fn fresh(&self) -> bool {
        is_fresh(&self.checked_at)
    }

    /// 某个运行时是否检测到。
    pub fn result_for(&self, runtime_id: &str) -> Option<&AgentScanResult> {
        self.results
            .iter()
            .find(|result| result.runtime_id == runtime_id)
    }
}

fn is_fresh(checked_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(checked_at)
        .map(|time| chrono::Utc::now().signed_duration_since(time).num_seconds() < SCAN_TTL_SECS)
        .unwrap_or(false)
}

fn scan_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SCAN_FILE)
}

pub fn load(data_dir: &Path) -> Option<AgentScanSnapshot> {
    read_json(&scan_path(data_dir))
}

/// 扫描全部运行时并落盘。返回的新快照由调用方广播给前端。
pub fn scan(data_dir: &Path) -> AgentScanSnapshot {
    let results = scan_runtimes(&runtime_catalog());
    let snapshot = AgentScanSnapshot {
        checked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        results,
    };
    if let Err(error) = write_json_atomic(&scan_path(data_dir), &snapshot) {
        tracing::warn!(%error, "failed to persist agent scan results");
    }
    snapshot
}

/// 解析 + 版本探测。抽出来便于单测，不依赖应用数据目录。
pub fn scan_runtimes(runtimes: &[AgentRuntimeDescriptor]) -> Vec<AgentScanResult> {
    let mut results: Vec<AgentScanResult> = runtimes
        .iter()
        .map(|runtime| {
            let resolved = resolve_runtime(runtime);
            AgentScanResult {
                runtime_id: runtime.id.to_string(),
                name: runtime.name.to_string(),
                binary: runtime.binary.to_string(),
                resolved_path: resolved
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                version: None,
                found: resolved.is_some(),
                error: None,
            }
        })
        .collect();

    let probes: Vec<(usize, PathBuf)> = results
        .iter()
        .enumerate()
        .filter_map(|(index, result)| {
            result
                .resolved_path
                .as_ref()
                .map(|path| (index, PathBuf::from(path)))
        })
        .collect();

    // 分批并行探测：每批最多 6 个进程，批内并行、批间串行。
    for chunk in probes.chunks(MAX_PARALLEL_PROBES) {
        let probed: Vec<(usize, Result<String, String>)> = thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(index, path)| {
                    let index = *index;
                    let path = path.clone();
                    (index, scope.spawn(move || (index, probe_version(&path))))
                })
                .collect();
            handles
                .into_iter()
                .map(|(index, handle)| {
                    handle
                        .join()
                        .unwrap_or_else(|_| (index, Err("版本探测线程崩溃".to_string())))
                })
                .collect()
        });

        for (index, outcome) in probed {
            let Some(result) = results.get_mut(index) else {
                continue;
            };
            match outcome {
                Ok(version) => result.version = Some(version),
                Err(error) => result.error = Some(error),
            }
        }
    }

    results
}

/// 默认命令优先，找不到再试别名；别名只用于检测，不参与启动。
fn resolve_runtime(runtime: &AgentRuntimeDescriptor) -> Option<PathBuf> {
    resolve_executable(runtime.binary).or_else(|| {
        runtime
            .aliases
            .iter()
            .find_map(|alias| resolve_executable(alias))
    })
}

/// 跑一次 `--version`，取首行非空输出。失败不影响“已安装”的结论。
pub(crate) fn probe_version(path: &Path) -> Result<String, String> {
    let display = path.display();
    let mut child = Command::new(path)
        .env("PATH", shell_path::user_path())
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 {display}：{error}"))?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= VERSION_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{display} --version 超时（5 秒）"));
                }
                thread::sleep(Duration::from_millis(80));
            }
            Err(error) => return Err(format!("等待 {display} --version 失败：{error}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version = [stdout.as_ref(), stderr.as_ref()]
        .into_iter()
        .flat_map(|text| text.lines())
        .map(str::trim)
        .find(|line| !line.is_empty());

    version
        .map(str::to_string)
        .ok_or_else(|| format!("{display} --version 没有输出"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(
        id: &'static str,
        binary: &'static str,
        aliases: Vec<&'static str>,
    ) -> AgentRuntimeDescriptor {
        AgentRuntimeDescriptor {
            id,
            name: id,
            vendor: "test",
            description: "",
            binary,
            aliases,
            args: Vec::new(),
            models: Vec::new(),
            permissions: Vec::new(),
            prompt_injection: crate::agent::PromptInjection::Stdin,
            prompt_flag: None,
            argv_separator: None,
            session_hook: false,
            hook_kind: Default::default(),
            available: true,
            capabilities: crate::agent::AgentRuntimeCapabilities {
                interactive_terminal: true,
                permission_prompt: true,
                external_decision: false,
                commit_review: true,
            },
            lifecycle: Vec::new(),
            limitations: Vec::new(),
            fallback: "",
        }
    }

    #[test]
    fn snapshot_freshness_is_a_rolling_day() {
        let now = chrono::Utc::now();
        let fresh = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        assert!(is_fresh(&fresh));

        let stale =
            (now - chrono::Duration::hours(25)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        assert!(!is_fresh(&stale));
        assert!(!is_fresh(""));
        assert!(!is_fresh("not a timestamp"));
    }

    #[test]
    fn missing_binaries_are_reported_without_probing() {
        let results = scan_runtimes(&[runtime(
            "definitely-missing",
            "tapd-missing-agent-binary",
            vec!["tapd-missing-alias"],
        )]);
        assert_eq!(results.len(), 1);
        assert!(!results[0].found);
        assert!(results[0].resolved_path.is_none());
        assert!(results[0].version.is_none());
        assert!(results[0].error.is_none());
    }

    #[test]
    fn scan_keeps_catalog_order_and_ids() {
        let runtimes = [
            runtime("first", "tapd-missing-a", Vec::new()),
            runtime("second", "tapd-missing-b", Vec::new()),
        ];
        let results = scan_runtimes(&runtimes);
        assert_eq!(
            results
                .iter()
                .map(|result| result.runtime_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }
}

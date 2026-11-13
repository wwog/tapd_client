//! Fetching TAPD media into the local cache and handing files to the OS.

use std::time::Duration;

use tapd_core::export::MediaKind;
use tauri::{AppHandle, Manager};

use crate::{media, open_with, session, state::SharedState};

/// An explicit `target`, or the saved choice for `kind`.
pub(super) fn selected_open_target(
    state: &SharedState,
    target: Option<String>,
    kind: &str,
) -> String {
    match target {
        Some(target) if !target.trim().is_empty() => target,
        _ => {
            let open_with = state.config.lock().expect("config lock").open_with.clone();
            open_with::selected_target(kind, &open_with)
        }
    }
}

/// Opens a downloaded file with the selected target app (or the system default).
pub(super) fn open_local(path: &std::path::Path, target: &str) -> Result<(), String> {
    let path = path.to_string_lossy().to_string();
    if target == open_with::SYSTEM_TARGET {
        return run_open(&[path.as_str()]);
    }

    let app =
        open_with::app_path_for(target).ok_or_else(|| format!("找不到要使用的应用：{target}"))?;
    run_open(&["-a", &app.to_string_lossy(), path.as_str()])
}

/// Runs `open` and waits for it, so a bad app path surfaces as an error instead
/// of silently doing nothing.
pub(super) fn run_open(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(args)
        .status()
        .map_err(|error| format!("启动打开命令失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("打开失败（open 退出码 {status}）"))
    }
}

/// Downloads into `media-cache`, reusing a previous download for the same URL.
pub(crate) async fn download_media(
    app: &AppHandle,
    paths: &tapd_core::paths::AppPaths,
    url: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = paths.data_dir.join("media-cache");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let name = format!(
        "{:016x}-{}",
        media::fnv1a(url.as_bytes()),
        media_filename(url)
    );
    let path = dir.join(&name);
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(path);
    }

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建".to_string())?;
    let cookie = session::cookie_header(&window)?;

    let response = reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::REFERER, media::REFERER)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败（HTTP {status}）"));
    }
    if response.content_length().unwrap_or(0) > media::MAX_FILE_BYTES {
        return Err("文件超过 300MB，已跳过".to_string());
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > media::MAX_FILE_BYTES {
        return Err("文件超过 300MB，已跳过".to_string());
    }
    if media::content_type_is_html(&content_type) && !bytes.starts_with(b"\x89PNG") {
        return Err(format!("下载被拒绝（{content_type}）"));
    }

    // `MediaKind::File` keeps the old cache-name behavior: an unknown content
    // type does not invent an extension.
    let name = media::with_extension(&name, &content_type, MediaKind::File);
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;
    Ok(path)
}

fn media_filename(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let raw = path.rsplit('/').next().unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .filter(|character| character.is_alphanumeric() || matches!(character, '.' | '-' | '_'))
        .take(90)
        .collect();
    let cleaned = cleaned.trim_matches(['.', '-', '_']).to_string();
    if cleaned.is_empty() {
        "media".to_string()
    } else {
        cleaned
    }
}

/// Accepts any `tapd.cn` host, so avatars served from `viper.tapd.cn` are
/// proxied with the session cookie just like captures and attachments.
///
/// The URL is parsed with the same WHATWG rules the HTTP client uses, so the
/// host approved here is the host the request actually reaches. Hand-rolled
/// splitting is not equivalent: `https://evil.com\@file.tapd.cn/x` reads as
/// `file.tapd.cn` by hand, while the parser (and therefore the request that
/// carries the TAPD session cookie) goes to `evil.com`.
pub(crate) fn is_tapd_media_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();

    host == "tapd.cn" || host.ends_with(".tapd.cn")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allows_tapd_media_urls() {
        assert!(is_tapd_media_url(
            "https://www.tapd.cn/tfl/captures/2026-11/a.png"
        ));
        assert!(is_tapd_media_url(
            "https://file.tapd.cn/1/attachments/download/2/a.png"
        ));
        assert!(is_tapd_media_url("https://viper.tapd.cn/user_logo/123.jpg"));
        assert!(is_tapd_media_url("http://tapd.cn/a.png"));
        assert!(!is_tapd_media_url("https://evil.example.com/a.png"));
        assert!(!is_tapd_media_url("https://tapd.cn.evil.example/a.png"));
        assert!(!is_tapd_media_url("file:///etc/passwd"));
        assert!(is_tapd_media_url("HTTPS://FILE.TAPD.CN/a.png"));
        assert!(is_tapd_media_url("https://tapd.cn./a.png"));
        assert!(is_tapd_media_url("https://file.tapd.cn:8443/a.png"));
    }

    #[test]
    fn rejects_urls_whose_real_host_is_not_tapd() {
        // 反斜杠在 WHATWG 解析里是路径分隔符：手工按 `@` 取 host 会误判为
        // file.tapd.cn，而请求实际打到 evil.com（并带上 TAPD Cookie）。
        assert!(!is_tapd_media_url(
            "https://evil.com\\@file.tapd.cn/collect.png"
        ));
        assert!(!is_tapd_media_url(
            "https://evil.example\\@file.tapd.cn/collect.png"
        ));
        // userinfo 形式同理：真实 host 是 @ 后面的 evil.com。
        assert!(!is_tapd_media_url(
            "https://file.tapd.cn@evil.com/collect.png"
        ));
        assert!(!is_tapd_media_url("https://file.tapd.cn@evil.com:443/x"));
        // userinfo 里的 `evil.com:443` 不影响真实 host，仍放行。
        assert!(is_tapd_media_url("https://evil.com:443@file.tapd.cn/x"));
        assert!(!is_tapd_media_url("javascript:alert(1)"));
        assert!(!is_tapd_media_url("//file.tapd.cn/a.png"));
    }

    #[test]
    fn builds_stable_cache_names() {
        assert_eq!(media::fnv1a(b"abc"), media::fnv1a(b"abc"));
        assert_ne!(media::fnv1a(b"abc"), media::fnv1a(b"abd"));
        assert_eq!(
            media_filename("https://file.tapd.cn/1/attachments/download/2/log.ips?x=1"),
            "log.ips"
        );
        assert_eq!(media_filename("https://www.tapd.cn/"), "media");
        assert_eq!(media_filename("https://www.tapd.cn/a/../b"), "b");
    }
}

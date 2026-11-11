//! JS evaluation bridge into the session webview.
//!
//! Remote pages are not granted access to application IPC commands, so both
//! paths go through `eval_with_callback` (native evaluation channel, no ACL).

use std::sync::Mutex;
use std::time::Duration;

use tauri::WebviewWindow;

/// Evaluates a synchronous expression and returns its JSON value.
///
/// Uses the native evaluation callback, which does not depend on remote IPC.
pub async fn eval_sync_json(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let mut last_error = String::new();

    for attempt in 0..3 {
        match eval_sync_once(window, expression, timeout).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let retryable = error.contains("callback dropped")
                    || error.contains("timed out")
                    || error.contains("empty bridge payload");
                last_error = error;
                if !retryable || attempt == 2 {
                    break;
                }
                // The hidden webview may still be navigating after startup/login.
                tokio::time::sleep(Duration::from_millis(350)).await;
            }
        }
    }

    Err(last_error)
}

/// Evaluates a synchronous expression exactly once.
///
/// Polling callers (the login screen) would otherwise stall for the full
/// timeout on every retry while the page is navigating.
pub async fn eval_sync_json_once(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    eval_sync_once(window, expression, timeout).await
}

async fn eval_sync_once(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let sender = Mutex::new(Some(sender));
    let script = format!("JSON.stringify(({expression}))");

    window
        .eval_with_callback(script, move |raw| {
            if let Some(sender) = sender.lock().expect("callback lock").take() {
                let _ = sender.send(raw);
            }
        })
        .map_err(|e| e.to_string())?;

    let raw = tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| format!("webview evaluation timed out after {}s", timeout.as_secs()))?
        .map_err(|_| "webview evaluation callback dropped".to_string())?;

    parse_bridge_payload(&raw)
}

/// Evaluates an async expression.
///
/// `eval_with_callback` does not await promises, so the expression runs in an
/// async IIFE that stores its result in a global bucket. Rust polls that bucket
/// through the native evaluation channel (no ACL involved).
pub async fn eval_async_json(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let start_script = format!(
        r#"
(function () {{
  var bucket = window.__TAPDCB_RESULTS__ || (window.__TAPDCB_RESULTS__ = {{}});
  var key = "{token}";
  bucket[key] = {{ state: "pending", at: Date.now() }};
  (async function () {{
    try {{
      var value = await ({expression});
      bucket[key] = {{ state: "ok", value: value === undefined ? null : value, at: Date.now() }};
    }} catch (error) {{
      bucket[key] = {{ state: "error", message: String((error && error.stack) || error), at: Date.now() }};
    }}
  }})();
  return {{ started: true }};
}})()
"#
    );

    let _ = eval_sync_json(window, &start_script, Duration::from_secs(5)).await?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::time::Instant::now() >= deadline {
            cleanup_result(window, &token).await;
            return Err(format!(
                "webview async evaluation timed out after {}s",
                timeout.as_secs()
            ));
        }

        tokio::time::sleep(Duration::from_millis(120)).await;

        let read_script = format!(
            r#"(function () {{
  try {{
    var bucket = window.__TAPDCB_RESULTS__;
    return bucket ? bucket["{token}"] : null;
  }} catch (error) {{
    return {{ state: "error", message: String(error) }};
  }}
}})()"#
        );

        match eval_sync_json(window, &read_script, Duration::from_secs(3)).await {
            Ok(serde_json::Value::Null) => continue,
            Ok(value) => {
                let state = value.get("state").and_then(|state| state.as_str()).unwrap_or("");
                if state == "ok" {
                    let result = value.get("value").cloned().unwrap_or(serde_json::Value::Null);
                    cleanup_result(window, &token).await;
                    return Ok(result);
                }
                if state == "error" {
                    let message = value
                        .get("message")
                        .and_then(|message| message.as_str())
                        .unwrap_or("unknown async bridge error")
                        .to_string();
                    cleanup_result(window, &token).await;
                    return Err(message);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

async fn cleanup_result(window: &WebviewWindow, token: &str) {
    let script = format!(
        r#"(function () {{
  try {{ delete window.__TAPDCB_RESULTS__["{token}"]; }} catch (error) {{}}
  return true;
}})()"#
    );
    let _ = eval_sync_json(window, &script, Duration::from_secs(2)).await;
}

fn parse_bridge_payload(raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty bridge payload (webview evaluation failed)".to_string());
    }

    let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|error| {
        let preview: String = trimmed.chars().take(180).collect();
        format!("invalid bridge payload: {error}; raw={preview}")
    })?;

    // `eval_with_callback` may JSON-encode the returned string a second time.
    if let serde_json::Value::String(inner) = &value {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(inner) {
            return Ok(parsed);
        }
    }

    Ok(value)
}

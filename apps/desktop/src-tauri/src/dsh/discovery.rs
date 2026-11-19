//! Host-side model discovery for the settings page.
//!
//! "Fetch models" used to be answered by the running engine (`ctx.llm`
//! discovery in the bridge plugin), which made the action depend on a runtime
//! that itself refused to start without a configured model — a bootstrap loop.
//! The listing is a plain authenticated GET, so the host performs it directly:
//! the action works while the runtime is stopped, starting or failed.
//!
//! The rules mirror dsh's `llm-pi-ai` discovery so the same endpoints answer
//! the same way: OpenAI protocols list at `{base}/models` with a bearer token,
//! Anthropic at `{root}/v1/models` with `x-api-key`, Gemini at `{base}/models`
//! with `x-goog-api-key`. Only the protocols whose listing this build can read
//! are interrogated; everything else asks the user to add models by hand.
//!
//! Nothing is stored here: the request carries a draft the settings page is
//! still editing, and the reply is candidate metadata for adoption.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION};
use reqwest::redirect::Policy;
use serde::Serialize;
use serde_json::Value;
use tapd_i18n::{tr, tr_args};

/// One candidate the endpoint advertises. The settings page appends the ids it
/// does not have yet and keeps its own tuning for the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
}

/// Total time one listing may take. A misconfigured gateway must not hold the
/// settings button forever.
const TIMEOUT: Duration = Duration::from_secs(20);

/// Endpoint replies larger than this are refused. The URL is user-supplied, so
/// the bound applies to the bytes actually read rather than a declared length.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Anthropic's public listing requires a stable API version.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Largest page each native listing accepts; discovery reads one page only.
const LISTING_LIMIT: u32 = 1000;

/// Protocols whose model listing this module can read.
fn listable(api: &str) -> bool {
    matches!(
        api,
        "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai"
    )
}

/// Join the endpoint base with the protocol's listing path. The base is a
/// prefix, not a URL to resolve against, so a deployment path such as
/// `/openai/v1` keeps its segments.
fn listing_url(base_url: &str, api: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match api {
        "google-generative-ai" => format!("{base}/models?pageSize={LISTING_LIMIT}"),
        "anthropic-messages" => {
            // Gateway documentation publishes both `.../v1` and the root as the
            // same base; the listing lives at the root's `/v1/models`.
            let root = base.strip_suffix("/v1").unwrap_or(base);
            format!("{root}/v1/models?limit={LISTING_LIMIT}")
        }
        _ => format!("{base}/models"),
    }
}

/// A positive integer field from the first usable candidate.
fn capacity(values: &[Option<&Value>]) -> Option<u64> {
    values.iter().flatten().find_map(|value| {
        value.as_u64().filter(|number| *number > 0).or_else(|| {
            value
                .as_f64()
                .filter(|number| *number > 0.0)
                .map(|number| number as u64)
        })
    })
}

/// A non-empty string field from the first usable candidate.
fn label<'a>(values: &[Option<&'a Value>]) -> Option<&'a str> {
    values
        .iter()
        .flatten()
        .find_map(|value| value.as_str().filter(|text| !text.is_empty()))
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|item| !item.is_null())
}

/// One entry of a supported `GET /models` reply.
fn read_entry(key: Option<&str>, raw: &Value) -> Option<DiscoveredModel> {
    let id = key
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .or_else(|| label(&[field(raw, "id")]).map(str::to_string))?;
    let name = label(&[
        field(raw, "name"),
        field(raw, "display_name"),
        field(raw, "displayName"),
    ])
    .unwrap_or(id.as_str())
    .to_string();
    let context_window = capacity(&[
        field(raw, "contextWindow"),
        field(raw, "context_window"),
        field(raw, "context_length"),
        field(raw, "max_input_tokens"),
        field(raw, "limit").and_then(|limit| field(limit, "context")),
    ]);
    let max_tokens = capacity(&[
        field(raw, "maxOutputTokens"),
        field(raw, "max_output_tokens"),
        field(raw, "maxTokens"),
        field(raw, "max_tokens"),
        field(raw, "limit").and_then(|limit| field(limit, "output")),
        field(raw, "top_provider").and_then(|top| field(top, "max_completion_tokens")),
    ]);
    Some(DiscoveredModel {
        id,
        name,
        context_window,
        max_tokens,
    })
}

/// Read the standard listing: a `data` array, or the enriched `models` map some
/// compatible gateways expose. Entries without a usable id are skipped rather
/// than failing the whole reply.
fn read_listing(body: &Value) -> Result<Vec<DiscoveredModel>, String> {
    let mut models = Vec::new();
    if let Some(rows) = field(body, "data").and_then(Value::as_array) {
        for raw in rows {
            if let Some(model) = read_entry(None, raw) {
                models.push(model);
            }
        }
        return Ok(models);
    }
    let Some(listing) = field(body, "models").and_then(Value::as_object) else {
        return Err(tr("dsh.discover.shape").to_string());
    };
    for (key, raw) in listing {
        if !raw.is_object() {
            continue;
        }
        if let Some(model) = read_entry(Some(key.as_str()), raw) {
            models.push(model);
        }
    }
    Ok(models)
}

/// Read a Gemini listing. Each entry's `name` is a resource name such as
/// `models/gemini-2.5-pro`; the request id is that name without the prefix.
/// Entries that declare generation methods without `generateContent` (embedding
/// models) cannot serve a conversation and are skipped.
fn read_gemini_listing(body: &Value) -> Result<Vec<DiscoveredModel>, String> {
    let Some(rows) = field(body, "models").and_then(Value::as_array) else {
        return Err(tr("dsh.discover.shape").to_string());
    };
    let mut models = Vec::new();
    for raw in rows {
        if let Some(methods) = field(raw, "supportedGenerationMethods").and_then(Value::as_array) {
            if !methods
                .iter()
                .any(|method| method.as_str() == Some("generateContent"))
            {
                continue;
            }
        }
        let Some(name) = label(&[field(raw, "name")]) else {
            continue;
        };
        let id = name.strip_prefix("models/").unwrap_or(name);
        if id.is_empty() {
            continue;
        }
        models.push(DiscoveredModel {
            id: id.to_string(),
            name: label(&[field(raw, "displayName")])
                .unwrap_or(id)
                .to_string(),
            context_window: capacity(&[field(raw, "inputTokenLimit")]),
            max_tokens: capacity(&[field(raw, "outputTokenLimit")]),
        });
    }
    Ok(models)
}

fn header_value(value: &str) -> Result<HeaderValue, String> {
    HeaderValue::from_str(value).map_err(|_| tr("dsh.discover.key").to_string())
}

/// Asks one draft endpoint which models it advertises.
pub async fn discover(
    base_url: &str,
    api: &str,
    api_key: Option<&str>,
) -> Result<Vec<DiscoveredModel>, String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err(tr("dsh.discover.baseUrl").to_string());
    }
    // A draft that has not chosen a protocol yet is asked as OpenAI Chat
    // Completions: it is the shape a gateway is overwhelmingly likely to speak.
    let api = if api.trim().is_empty() {
        "openai-completions"
    } else {
        api.trim()
    };
    if !listable(api) {
        return Err(tr_args("dsh.discover.unsupported", &[&api]));
    }

    let url = listing_url(base, api);
    let key = api_key.map(str::trim).filter(|value| !value.is_empty());
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    match api {
        "anthropic-messages" => {
            headers.insert(
                "anthropic-version",
                HeaderValue::from_static(ANTHROPIC_VERSION),
            );
            if let Some(key) = key {
                headers.insert("x-api-key", header_value(key)?);
            }
        }
        "google-generative-ai" => {
            if let Some(key) = key {
                headers.insert("x-goog-api-key", header_value(key)?);
            }
        }
        _ => {
            if let Some(key) = key {
                headers.insert(AUTHORIZATION, header_value(&format!("Bearer {key}"))?);
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|_| tr_args("dsh.discover.reach", &[&url]))?;
    let status = response.status();
    if !status.is_success() {
        return Err(
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                tr_args("dsh.discover.statusAuth", &[&url, &status.as_u16()])
            } else {
                tr_args("dsh.discover.status", &[&url, &status.as_u16()])
            },
        );
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(tr("dsh.discover.oversized").to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| tr_args("dsh.discover.reach", &[&url]))?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(tr("dsh.discover.oversized").to_string());
        }
        body.extend_from_slice(&chunk);
    }
    let body: Value =
        serde_json::from_slice(&body).map_err(|_| tr_args("dsh.discover.json", &[&url]))?;
    if api == "google-generative-ai" {
        read_gemini_listing(&body)
    } else {
        read_listing(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn listing_urls_follow_each_protocol() {
        assert_eq!(
            listing_url("https://api.example/v1/", "openai-completions"),
            "https://api.example/v1/models"
        );
        assert_eq!(
            listing_url("https://api.example/v1", "openai-responses"),
            "https://api.example/v1/models"
        );
        assert_eq!(
            listing_url("https://api.anthropic.com", "anthropic-messages"),
            "https://api.anthropic.com/v1/models?limit=1000"
        );
        // A base that already carries /v1 must not double the segment.
        assert_eq!(
            listing_url("https://gateway.example/anthropic/v1", "anthropic-messages"),
            "https://gateway.example/anthropic/v1/models?limit=1000"
        );
        assert_eq!(
            listing_url(
                "https://generativelanguage.googleapis.com/v1beta",
                "google-generative-ai"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
        );
    }

    #[test]
    fn data_array_reads_ids_and_capacities() {
        let models = read_listing(&json!({
            "data": [
                { "id": "alpha", "name": "Alpha", "context_length": 128000, "max_output_tokens": 8192 },
                { "id": "beta", "limit": { "context": 64000, "output": 4096 } },
                { "name": "no id" },
            ]
        }))
        .expect("listing");
        assert_eq!(
            models,
            vec![
                DiscoveredModel {
                    id: "alpha".into(),
                    name: "Alpha".into(),
                    context_window: Some(128_000),
                    max_tokens: Some(8_192),
                },
                DiscoveredModel {
                    id: "beta".into(),
                    name: "beta".into(),
                    context_window: Some(64_000),
                    max_tokens: Some(4_096),
                },
            ]
        );
    }

    #[test]
    fn models_map_uses_the_key_as_the_request_id() {
        let models = read_listing(&json!({
            "models": {
                "provider/alias": { "id": "canonical", "displayName": "Alias" },
                "meta": "not a model",
            }
        }))
        .expect("listing");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "provider/alias");
        assert_eq!(models[0].name, "Alias");
    }

    #[test]
    fn an_unreadable_reply_is_refused() {
        assert!(read_listing(&json!({ "error": "nope" })).is_err());
    }

    #[test]
    fn gemini_listing_strips_the_resource_prefix_and_skips_embeddings() {
        let models = read_gemini_listing(&json!({
            "models": [
                {
                    "name": "models/gemini-2.5-pro",
                    "displayName": "Gemini 2.5 Pro",
                    "inputTokenLimit": 1048576,
                    "outputTokenLimit": 65536,
                    "supportedGenerationMethods": ["generateContent", "countTokens"],
                },
                {
                    "name": "models/text-embedding-004",
                    "supportedGenerationMethods": ["embedContent"],
                },
            ]
        }))
        .expect("listing");
        assert_eq!(
            models,
            vec![DiscoveredModel {
                id: "gemini-2.5-pro".into(),
                name: "Gemini 2.5 Pro".into(),
                context_window: Some(1_048_576),
                max_tokens: Some(65_536),
            }]
        );
    }

    #[tokio::test]
    async fn discovery_calls_the_openai_listing_with_the_typed_key() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("connection");
            let mut buffer = [0u8; 4096];
            let read = socket.read(&mut buffer).await.expect("request");
            let request = String::from_utf8_lossy(&buffer[..read]).to_lowercase();
            assert!(request.starts_with("get /v1/models "), "{request}");
            assert!(
                request.contains("authorization: bearer secret"),
                "{request}"
            );
            let body = r#"{"data":[{"id":"m1","context_length":32000}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("response");
        });

        let models = discover(
            &format!("http://{address}/v1"),
            "openai-completions",
            Some("secret"),
        )
        .await
        .expect("discovery");
        server.await.expect("server task");
        assert_eq!(
            models,
            vec![DiscoveredModel {
                id: "m1".into(),
                name: "m1".into(),
                context_window: Some(32_000),
                max_tokens: None,
            }]
        );
    }
}

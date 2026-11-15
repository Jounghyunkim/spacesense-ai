//! LLM 연동 (Ollama / OpenAI 호환 / Anthropic). 웹뷰가 아닌 Rust 에서 호출해
//! CORS 문제를 피하고 API 키가 프론트엔드 네트워크 스택에 노출되지 않게 한다.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::settings::Settings;

#[derive(Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

fn api_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let hint = match status.as_u16() {
        401 | 403 => " (API 키를 확인하세요)",
        404 => " (모델 이름 또는 엔드포인트를 확인하세요)",
        429 => " (요청 한도 초과 - 잠시 후 다시 시도하세요)",
        _ => "",
    };
    format!("{} 오류 {}{}: {}", provider, status.as_u16(), hint, detail)
}

async fn post(
    provider: &str,
    req: reqwest::RequestBuilder,
    body: &Value,
) -> Result<Value, String> {
    let resp = req.json(body).send().await.map_err(|e| {
        if e.is_connect() {
            format!("{} 서버에 연결할 수 없습니다. 엔드포인트/네트워크를 확인하세요. ({})", provider, e)
        } else if e.is_timeout() {
            format!("{} 응답 시간이 초과되었습니다.", provider)
        } else {
            format!("{} 요청 실패: {}", provider, e)
        }
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(provider, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("{} 응답 파싱 실패: {}", provider, e))
}

fn with_system(system: &str, messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = vec![json!({"role": "system", "content": system})];
    out.extend(messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
    out
}

pub async fn chat(
    s: &Settings,
    system: &str,
    messages: &[ChatMessage],
    want_json: bool,
) -> Result<String, String> {
    let http = client()?;
    match s.provider.as_str() {
        "ollama" => {
            let url = format!("{}/api/chat", s.ollama_url.trim().trim_end_matches('/'));
            let mut body = json!({
                "model": s.ollama_model.trim(),
                "stream": false,
                "messages": with_system(system, messages),
            });
            if want_json {
                body["format"] = json!("json");
            }
            let v = post("Ollama", http.post(url), &body).await?;
            v.pointer("/message/content")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "Ollama 응답에 내용이 없습니다.".to_string())
        }
        "openai" => {
            if s.openai_key.trim().is_empty() {
                return Err("OpenAI API 키가 설정되지 않았습니다. 설정에서 입력하세요.".into());
            }
            let url = format!("{}/chat/completions", s.openai_base_url.trim().trim_end_matches('/'));
            let mut body = json!({
                "model": s.openai_model.trim(),
                "messages": with_system(system, messages),
            });
            if want_json {
                body["response_format"] = json!({"type": "json_object"});
            }
            let v = post("OpenAI", http.post(url).bearer_auth(s.openai_key.trim()), &body).await?;
            v.pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "OpenAI 응답에 내용이 없습니다.".to_string())
        }
        "anthropic" => {
            if s.anthropic_key.trim().is_empty() {
                return Err("Claude API 키가 설정되지 않았습니다. 설정에서 입력하세요.".into());
            }
            let model = s.anthropic_model.trim();
            let mut body = json!({
                "model": model,
                "max_tokens": 16000,
                "system": system,
                "messages": messages
                    .iter()
                    .map(|m| json!({"role": m.role, "content": m.content}))
                    .collect::<Vec<_>>(),
            });
            let mut req = http
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", s.anthropic_key.trim())
                .header("anthropic-version", "2026-10-21");
            // 안전 분류기 거절 시 서버 측 폴백을 지원하는 모델에서만 활성화한다.
            const FALLBACK_MODELS: &[&str] = &[
                "claude-opus-5-5",
                "claude-opus-5",
                "claude-sonnet-5-5",
                "claude-fable-5-2",
                "claude-fable-5-1",
            ];
            if FALLBACK_MODELS.contains(&model) {
                body["fallbacks"] = json!("default");
                req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
            }
            let v = post("Claude", req, &body).await?;
            if v.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
                return Err("Claude 가 이 요청에 대한 응답을 거절했습니다.".into());
            }
            let text: String = v
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            if text.is_empty() {
                let truncated = v.get("stop_reason").and_then(Value::as_str) == Some("max_tokens");
                return Err(if truncated {
                    "Claude 응답이 출력 한도에서 잘렸습니다.".into()
                } else {
                    "Claude 응답에 내용이 없습니다.".to_string()
                });
            }
            Ok(text)
        }
        other => Err(format!("알 수 없는 LLM Provider: {}", other)),
    }
}

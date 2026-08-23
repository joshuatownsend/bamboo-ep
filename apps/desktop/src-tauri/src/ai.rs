//! Talking to the user's chosen AI provider.
//!
//! Three things put this in Rust rather than in the web layer.
//!
//! 1. **The key never enters the webview.** It is read from the credential
//!    store directly into the outgoing request. The web layer can ask whether
//!    a key exists and can save one, but it has no way to read one back.
//! 2. **The capability pin cannot express a runtime base URL.**
//!    `capabilities/default.json` allows `tauri-plugin-http` to reach BambooHR
//!    and nothing else, which is exactly right and cannot be widened to cover
//!    a URL the user types in. So this request does not go through that
//!    plugin at all.
//! 3. **Somebody has to decide where the certificate is allowed to be sent.**
//!    That check lives here, next to the code that does the sending.
//!
//! What comes back is the model's answer as raw text. It is NOT interpreted
//! here: parsing and validating the extraction belongs in `packages/core`,
//! where it is unit-tested and shared, and where a change to the prompt and a
//! change to the parser can be made in one place.

use keyring::Entry;
use serde_json::{json, Value};
use std::time::Duration;

use crate::KEYRING_SERVICE;

/// A model may spend a while on a large scan; a minute is generous without
/// letting a wedged endpoint hang the review screen indefinitely.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

/// Enough for the JSON object asked for, with room for a model that narrates
/// before answering. Not enough to pay for a runaway generation.
const MAX_TOKENS: u32 = 1024;

fn ai_entry(provider: &str) -> Result<Entry, String> {
    // Namespaced so an AI key can never collide with a BambooHR subdomain,
    // and so switching provider does not overwrite the previous key.
    Entry::new(KEYRING_SERVICE, &format!("ai:{provider}"))
        .map_err(|e| format!("Credential store unavailable: {e}"))
}

#[tauri::command]
pub fn save_ai_key(provider: String, api_key: String) -> Result<(), String> {
    ai_entry(&provider)?
        .set_password(&api_key)
        .map_err(|e| format!("Could not save the AI provider key: {e}"))
}

/// Deliberately returns a bool and not the key. Nothing in the web layer has a
/// reason to hold the secret, so nothing is given the chance to leak it into a
/// log, a crash report, or a settings file.
#[tauri::command]
pub fn has_ai_key(provider: String) -> Result<bool, String> {
    match ai_entry(&provider)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("Could not read the stored AI provider key: {e}")),
    }
}

#[tauri::command]
pub fn delete_ai_key(provider: String) -> Result<(), String> {
    match ai_entry(&provider)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the stored AI provider key: {e}")),
    }
}

/// Where a certificate is allowed to be sent, and whether that is off-machine.
///
/// A plain-HTTP endpoint would put a scan of someone's identity documents on
/// the wire in the clear, so it is refused - except on the loopback address,
/// where it never reaches a network and is how every local model server
/// (Ollama, LM Studio, llama.cpp) is actually addressed.
///
/// Returns whether the destination is loopback, which also decides whether an
/// API key is required at all.
fn check_destination(base_url: &str) -> Result<bool, String> {
    let url = reqwest::Url::parse(base_url)
        .map_err(|e| format!("\"{base_url}\" is not a valid address: {e}"))?;

    let host = url.host_str().unwrap_or("");
    let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");

    match url.scheme() {
        "https" => Ok(is_loopback),
        "http" if is_loopback => Ok(true),
        "http" => Err(format!(
            "Refusing to send a certificate to {host} over plain HTTP. \
             Use an https:// address, or a local model on localhost."
        )),
        other => Err(format!("Unsupported address scheme \"{other}\".")),
    }
}

/// Send one page image to the model and return its answer verbatim.
///
/// `provider` selects the request shape, not the vendor: "openai" is the shape
/// that Ollama, LM Studio, OpenRouter, Together and most proxies also speak,
/// which is the whole reason it is offered alongside Anthropic.
#[tauri::command]
pub async fn ai_extract(
    provider: String,
    base_url: String,
    model: String,
    prompt: String,
    schema: Value,
    image_base64: String,
    image_mime: String,
) -> Result<String, String> {
    let is_local = check_destination(&base_url)?;

    // A local model server takes no credentials, and demanding one would make
    // the only configuration that sends nothing off this machine the one
    // configuration that cannot be used without first inventing a fake secret.
    let api_key = match ai_entry(&provider)?.get_password() {
        Ok(secret) => Some(secret),
        Err(keyring::Error::NoEntry) if is_local => None,
        Err(keyring::Error::NoEntry) => {
            return Err("No API key is saved for this AI provider yet.".to_string())
        }
        Err(other) => {
            return Err(format!("Could not read the stored AI provider key: {other}"))
        }
    };

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not start the request: {e}"))?;

    let root = base_url.trim_end_matches('/');
    let request = match provider.as_str() {
        "anthropic" => {
            let builder = client
                .post(format!("{root}/v1/messages"))
                .header("anthropic-version", "2023-06-01")
                .json(&anthropic_body(&model, &prompt, &schema, &image_base64, &image_mime));
            match &api_key {
                Some(key) => builder.header("x-api-key", key),
                None => builder,
            }
        }
        "openai" => {
            let builder = client
                .post(format!("{root}/chat/completions"))
                .json(&openai_body(&model, &prompt, &image_base64, &image_mime));
            match &api_key {
                Some(key) => builder.bearer_auth(key),
                None => builder,
            }
        }
        other => return Err(format!("Unknown AI provider \"{other}\".")),
    };

    let response = request
        .send()
        .await
        .map_err(|e| format!("Could not reach the AI provider: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("The AI provider's reply could not be read: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "The AI provider returned {}: {}",
            status.as_u16(),
            provider_error_message(&body)
        ));
    }

    let parsed: Value = serde_json::from_str(&body)
        .map_err(|e| format!("The AI provider's reply was not JSON: {e}"))?;

    // Only the envelope is unwrapped here. What the model actually said is
    // handed back untouched for `packages/core` to parse and validate.
    match provider.as_str() {
        "anthropic" => anthropic_answer(&parsed),
        _ => openai_answer(&parsed),
    }
}

/// Forced tool use is the strongest structure Anthropic offers: the model
/// cannot answer in prose, because the only move available to it is to call
/// the tool with arguments matching the schema.
fn anthropic_body(
    model: &str,
    prompt: &str,
    schema: &Value,
    image_base64: &str,
    image_mime: &str,
) -> Value {
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "tools": [{
            "name": "record_certificate",
            "description": "Record exactly what is printed on this certificate.",
            "input_schema": schema,
        }],
        "tool_choice": { "type": "tool", "name": "record_certificate" },
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image_mime,
                        "data": image_base64,
                    },
                },
                { "type": "text", "text": prompt },
            ],
        }],
    })
}

/// `json_object` rather than `json_schema` on purpose. Most of the servers
/// that call themselves OpenAI-compatible reject the stricter form, and the
/// schema is described in the prompt anyway - the parser in `core` is what
/// actually enforces the shape, so a strict server buys nothing here and a
/// lenient one would otherwise be locked out.
fn openai_body(model: &str, prompt: &str, image_base64: &str, image_mime: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "response_format": { "type": "json_object" },
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": { "url": format!("data:{image_mime};base64,{image_base64}") },
                },
                { "type": "text", "text": prompt },
            ],
        }],
    })
}

fn anthropic_answer(parsed: &Value) -> Result<String, String> {
    let blocks = parsed["content"].as_array().ok_or_else(|| {
        "The AI provider's reply had no content block.".to_string()
    })?;

    // The tool call is the answer. A model that talked instead of calling the
    // tool has not answered, but its prose is still the most useful thing to
    // show the user, so fall through to it rather than reporting nothing.
    for block in blocks {
        if block["type"] == "tool_use" {
            return Ok(block["input"].to_string());
        }
    }
    for block in blocks {
        if let Some(text) = block["text"].as_str() {
            return Ok(text.to_string());
        }
    }
    Err("The AI provider returned an empty answer.".to_string())
}

fn openai_answer(parsed: &Value) -> Result<String, String> {
    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "The AI provider returned an empty answer.".to_string())
}

/// Providers disagree on where the message lives; try the two common shapes
/// before falling back to the raw body, truncated so a stray HTML error page
/// cannot flood the UI.
fn provider_error_message(body: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<Value>(body) {
        for path in [&parsed["error"]["message"], &parsed["message"]] {
            if let Some(message) = path.as_str() {
                return message.to_string();
            }
        }
    }
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_https_and_refuses_plain_http_to_the_internet() {
        assert_eq!(check_destination("https://api.anthropic.com"), Ok(false));
        assert!(check_destination("http://example.com/v1").is_err());
    }

    // The bool is what decides whether a key is required, so it is asserted
    // rather than merely "did not error": getting it wrong either strands the
    // local workflow or lets a key-less request reach a real provider.
    #[test]
    fn allows_plain_http_on_loopback_where_local_models_live() {
        assert_eq!(check_destination("http://localhost:11434/v1"), Ok(true));
        assert_eq!(check_destination("http://127.0.0.1:1234/v1"), Ok(true));
    }

    #[test]
    fn refuses_addresses_that_are_not_addresses() {
        assert!(check_destination("not a url").is_err());
        assert!(check_destination("file:///etc/passwd").is_err());
    }

    #[test]
    fn reads_the_tool_call_as_the_answer() {
        let reply = json!({
            "content": [
                { "type": "text", "text": "Let me look." },
                { "type": "tool_use", "input": { "certificationName": "CPR" } },
            ]
        });
        assert_eq!(
            anthropic_answer(&reply).unwrap(),
            r#"{"certificationName":"CPR"}"#
        );
    }

    #[test]
    fn falls_back_to_prose_when_the_model_declined_to_call_the_tool() {
        let reply = json!({ "content": [{ "type": "text", "text": "I cannot read this." }] });
        assert_eq!(anthropic_answer(&reply).unwrap(), "I cannot read this.");
    }

    #[test]
    fn surfaces_the_provider_s_own_error_message() {
        let body = r#"{"error":{"message":"invalid x-api-key"}}"#;
        assert_eq!(provider_error_message(body), "invalid x-api-key");
    }
}

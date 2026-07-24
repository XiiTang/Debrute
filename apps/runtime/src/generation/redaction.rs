//! Persistent Model Run redaction before Project metadata storage.

use std::sync::OnceLock;

const REDACTED: &str = "[REDACTED]";
const INLINE_PAYLOAD: &str = "[INLINE_MEDIA_REDACTED]";
const INLINE_STRING_LIMIT: usize = 4_096;

pub(crate) fn redact_model_run_value(
    value: &serde_json::Value,
    configured_secrets: impl IntoIterator<Item = String>,
) -> serde_json::Value {
    let secrets = configured_secrets
        .into_iter()
        .map(|secret| secret.trim().to_owned())
        .filter(|secret| !secret.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let mut secrets = secrets.into_iter().collect::<Vec<_>>();
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    redact_value(value, &secrets, None)
}

fn redact_value(
    value: &serde_json::Value,
    secrets: &[String],
    key: Option<&str>,
) -> serde_json::Value {
    if key.is_some_and(is_secret_key) {
        return serde_json::Value::String(REDACTED.to_owned());
    }
    if key.is_some_and(is_inline_media_key) && value.is_string() {
        return serde_json::Value::String(INLINE_PAYLOAD.to_owned());
    }
    match value {
        serde_json::Value::Object(record) => serde_json::Value::Object(
            record
                .iter()
                .map(|(key, value)| (key.clone(), redact_value(value, secrets, Some(key))))
                .collect(),
        ),
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .iter()
                .map(|value| redact_value(value, secrets, key))
                .collect(),
        ),
        serde_json::Value::String(value) => {
            serde_json::Value::String(redact_string(value, secrets))
        }
        _ => value.clone(),
    }
}

fn redact_string(value: &str, secrets: &[String]) -> String {
    if value.starts_with("data:") || looks_like_large_base64(value) {
        return INLINE_PAYLOAD.to_owned();
    }
    let mut redacted = redact_embedded_urls(value);
    for secret in secrets {
        if redacted.contains(secret) {
            redacted = redacted.replace(secret, REDACTED);
        }
    }
    redacted
}

fn redact_embedded_urls(value: &str) -> String {
    static URLS: OnceLock<regex::Regex> = OnceLock::new();
    let urls = URLS.get_or_init(|| {
        regex::Regex::new(r#"https?://[^\s\"'<>]+"#).expect("embedded URL regex is valid")
    });
    let redacted = urls.replace_all(value, |captures: &regex::Captures<'_>| {
        redact_url(&captures[0]).unwrap_or_else(|| captures[0].to_owned())
    });
    if redacted == value {
        redact_url(value).unwrap_or_else(|| value.to_owned())
    } else {
        redacted.into_owned()
    }
}

fn redact_url(value: &str) -> Option<String> {
    let mut url = url::Url::parse(value).ok()?;
    let mut changed = false;
    let pairs = url
        .query_pairs()
        .map(|(key, value)| {
            if is_secret_key(&key) {
                changed = true;
                (key.into_owned(), REDACTED.to_owned())
            } else {
                (key.into_owned(), value.into_owned())
            }
        })
        .collect::<Vec<_>>();
    if !changed {
        return None;
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
    Some(url.into())
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    matches!(
        normalized.as_slice(),
        b"authorization"
            | b"apikey"
            | b"key"
            | b"token"
            | b"accesstoken"
            | b"refreshtoken"
            | b"idtoken"
            | b"secret"
            | b"clientsecret"
            | b"password"
            | b"privatekey"
            | b"proxyauthorization"
            | b"cookie"
            | b"setcookie"
            | b"credential"
            | b"credentials"
            | b"signature"
            | b"sig"
            | b"xamzsignature"
            | b"xamzcredential"
            | b"googsignature"
            | b"policy"
            | b"xapikey"
    )
}

fn is_inline_media_key(key: &str) -> bool {
    let normalized = key
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    matches!(
        normalized.as_slice(),
        b"data" | b"b64json" | b"imagebase64" | b"audiobase64"
    )
}

fn looks_like_large_base64(value: &str) -> bool {
    value.len() > INLINE_STRING_LIMIT
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_model_runs_remove_secrets_urls_and_inline_media() {
        let value = serde_json::json!({
            "headers": {"Authorization": "Bearer live-secret"},
            "url": "https://example.test/output?api_key=live-secret&item=1",
            "nested": ["prefix live-secret suffix", "data:image/png;base64,AAAA"],
            "shortInline": {"data": "AQID"},
            "safe": "prompt"
        });
        let redacted = redact_model_run_value(&value, ["live-secret".to_owned()]);
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("live-secret"));
        assert!(serialized.contains(REDACTED));
        assert!(serialized.contains(INLINE_PAYLOAD));
        assert!(!serialized.contains("AQID"));
        assert_eq!(redacted["safe"], "prompt");
    }

    #[test]
    fn persistent_model_runs_remove_overlapping_secrets_cookies_and_embedded_urls() {
        let value = serde_json::json!({
            "cookie": "session=live",
            "proxyAuthorization": "Bearer live",
            "message": "failed at https://example.test/out?refresh_token=secret-token&safe=1",
            "nested": "prefix sk-overlap-long suffix"
        });
        let redacted = redact_model_run_value(
            &value,
            ["sk-overlap".to_owned(), "sk-overlap-long".to_owned()],
        );
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("session=live"));
        assert!(!serialized.contains("Bearer live"));
        assert!(!serialized.contains("secret-token"));
        assert!(!serialized.contains("-long"));
        assert!(serialized.contains("safe=1"));
    }
}

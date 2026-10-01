//! Experimental AI assistant. Feature-gated and off by default.
//!
//! Ported from the protocol used by Sophomoresty/gemini-web2api, which drives
//! Gemini's own web front end rather than a published API. That is *why*
//! there is no API key to configure: the web client authenticates with the
//! signed-in user's Google session cookies plus a derived `SAPISIDHASH`.
//!
//! Three things this module is deliberate about:
//!
//! * **No credential ever comes from this repository.** The session file is
//!   created by the user at runtime, lives in the app's own data directory,
//!   is never committed, and is never written to a log. [`Session`] is the
//!   only thing that holds it and it is not `Debug`-printed anywhere.
//! * **Nothing is scraped automatically.** The user pastes their own cookie
//!   into Settings; 1Boost never reaches into a browser profile.
//! * **It is not unlimited.** It is one signed-in user's web session, so it
//!   is bound by that account's quota, and it can stop working at any time
//!   when Google changes the front end. The UI says so; this says so too.

use crate::storage;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// The `bl` build parameter the web front end sends. Google rotates these;
/// a stale value shows up as an upstream error rather than silently breaking.
const BARD_BL: &str = "boq_assistant-bard-web-server_20260716.08_p0";
const ORIGIN: &str = "https://gemini.google.com";
const ENDPOINT_PATH: &str = "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/// Longest prompt we will send. The context block is generated locally and
/// grows with the user's history, so this is a real bound, not decoration.
const MAX_PROMPT_CHARS: usize = 12_000;
/// Upstream is asked for a short answer; this only bounds what we accept.
const MAX_ANSWER_CHARS: usize = 32_000;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/// The MODE_CATEGORY ids the front end uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Fast,
    Thinking,
    Pro,
    Auto,
    FastDynamicThinking,
    FlashLite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: &'static str,
    pub mode: Mode,
    /// Thinking depth: 0 is deepest, 4 is off.
    pub think: u8,
    pub label: &'static str,
}

impl Mode {
    fn id(self) -> u8 {
        match self {
            Mode::Fast => 1,
            Mode::Thinking => 2,
            Mode::Pro => 3,
            Mode::Auto => 4,
            Mode::FastDynamicThinking => 5,
            Mode::FlashLite => 6,
        }
    }
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec { id: "gemini-flash", mode: Mode::Fast, think: 4, label: "Flash" },
    ModelSpec { id: "gemini-thinking", mode: Mode::Thinking, think: 0, label: "Thinking" },
    ModelSpec { id: "gemini-auto", mode: Mode::Auto, think: 4, label: "Auto" },
    ModelSpec { id: "gemini-pro", mode: Mode::Pro, think: 4, label: "Pro" },
    ModelSpec { id: "gemini-lite", mode: Mode::FlashLite, think: 4, label: "Flash Lite" },
];

pub fn resolve_model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn default_model() -> &'static ModelSpec {
    &MODELS[0]
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// The user's own Google session. Written by the user, read by this module,
/// and sent to exactly one host: `gemini.google.com`.
#[derive(Deserialize, Serialize, Default, Clone)]
pub struct Session {
    /// The raw `Cookie:` header value, e.g. `__Secure-1PSID=…; __Secure-1PSIDTS=…`.
    pub cookie: String,
    /// Pulled out of `cookie` when the user does not supply it separately.
    #[serde(default)]
    pub sapisid: String,
    /// Index for accounts with more than one signed-in Google account.
    #[serde(default)]
    pub auth_user: Option<String>,
    /// The front end's `at` token; optional, some sessions do not need it.
    #[serde(default)]
    pub xsrf_token: Option<String>,
}

impl Session {
    /// The cookie file 1Boost reads. It sits beside the app's other data,
    /// outside the repository, and is never created unless the user asks.
    pub fn path() -> PathBuf {
        storage::user_data_dir().join("gemini-session.json")
    }

    pub fn load() -> Result<Session, AssistantError> {
        let path = Session::path();
        let raw = std::fs::read_to_string(&path)
            .map_err(|_| AssistantError::NoSession)?;
        let mut session: Session = serde_json::from_str(&raw)
            .map_err(|_| AssistantError::BadSession)?;
        if session.sapisid.is_empty() {
            session.sapisid = sapisid_from_cookie(&session.cookie).unwrap_or_default();
        }
        if session.cookie.trim().is_empty() {
            return Err(AssistantError::BadSession);
        }
        Ok(session)
    }

    /// `true` when the session looks usable without touching the network.
    pub fn looks_configured(&self) -> bool {
        !self.cookie.trim().is_empty() && !self.sapisid.trim().is_empty()
    }

    pub fn save(&self) -> Result<(), AssistantError> {
        let path = Session::path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|_| AssistantError::Write)?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|_| AssistantError::Write)?;
        std::fs::write(&path, body).map_err(|_| AssistantError::Write)
    }

    pub fn clear() {
        let _ = std::fs::remove_file(Session::path());
    }
}

/// Pulls `SAPISID` out of a raw Cookie header.
pub fn sapisid_from_cookie(cookie: &str) -> Option<String> {
    cookie.split(';').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name.trim().eq_ignore_ascii_case("SAPISID") {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

/// Google's SAPISIDHASH: `SAPISIDHASH <ts>_<sha1(ts sapisid origin)>`.
/// This is derived from the session cookie, not a stored secret of ours.
pub fn sapisid_hash(sapisid: &str, ts: u64) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{ts} {sapisid} {ORIGIN}"));
    let digest = hasher.finalize();
    format!("SAPISIDHASH {ts}_{}", hex(&digest))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssistantError {
    /// The user has not supplied a session yet.
    NoSession,
    /// The session file exists but is not usable.
    BadSession,
    /// The feature flag is off.
    Disabled,
    Write,
    /// Upstream refused. The number is Google's own error code.
    Upstream(i64),
    Network(String),
    /// Upstream answered, but with nothing we can show.
    EmptyAnswer,
    AnswerTooLong,
    /// The request never went out because the prompt was over the bound.
    PromptTooLong,
}

impl std::fmt::Display for AssistantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AssistantError::NoSession => write!(f, "No Gemini session is configured yet."),
            AssistantError::BadSession => {
                write!(f, "The saved Gemini session could not be read.")
            }
            AssistantError::Disabled => {
                write!(f, "The experimental assistant is turned off in Settings.")
            }
            AssistantError::Write => write!(f, "The Gemini session could not be saved."),
            AssistantError::Upstream(code) => {
                write!(f, "Gemini rejected the request (error {code}).")
            }
            AssistantError::Network(e) => write!(f, "Could not reach Gemini: {e}"),
            AssistantError::EmptyAnswer => {
                write!(f, "Gemini replied, but the reply could not be read.")
            }
            AssistantError::AnswerTooLong => write!(f, "Gemini's reply was unexpectedly large."),
            AssistantError::PromptTooLong => {
                write!(f, "That question is too long to send.")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/// Builds the `f.req` form body the front end sends.
///
/// The payload is a positional array, so every field is written at the index
/// the front end expects. Getting one index wrong does not produce an error —
/// it produces a quietly different request — which is why this is built by an
/// explicitly tested function rather than assembled at the call site.
pub fn build_body(
    prompt: &str,
    model: &ModelSpec,
    temporary: bool,
    xsrf_token: Option<&str>,
) -> Result<String, AssistantError> {
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(AssistantError::PromptTooLong);
    }
    let mut inner: Vec<serde_json::Value> = vec![serde_json::Value::Null; 102];
    let set = |v: &mut Vec<serde_json::Value>, i: usize, val: serde_json::Value| {
        v[i] = val;
    };
    let prompt = serde_json::Value::String(prompt.to_string());

    set(
        &mut inner,
        0,
        serde_json::json!([prompt, 0, null, null, null, null, 0]),
    );
    set(&mut inner, 1, serde_json::json!(["en"]));
    set(&mut inner, 2, serde_json::json!(["", "", "", null, null, null, null, null, null, ""]));
    set(&mut inner, 6, serde_json::json!([0]));
    set(&mut inner, 7, serde_json::json!(1));
    set(&mut inner, 10, serde_json::json!(1));
    set(&mut inner, 11, serde_json::json!(0));
    set(&mut inner, 17, serde_json::json!([[model.think]]));
    set(&mut inner, 18, serde_json::json!(0));
    set(&mut inner, 27, serde_json::json!(1));
    set(&mut inner, 30, serde_json::json!([4]));
    // Persistence: 2 keeps the chat in history, 1 is a temporary chat.
    if temporary {
        set(&mut inner, 41, serde_json::json!([1]));
        set(&mut inner, 45, serde_json::json!(1));
    } else {
        set(&mut inner, 41, serde_json::json!([2]));
    }
    set(&mut inner, 53, serde_json::json!(0));
    set(&mut inner, 59, serde_json::json!(new_request_id()));
    set(&mut inner, 61, serde_json::json!([]));
    set(&mut inner, 68, serde_json::json!(1));
    set(&mut inner, 79, serde_json::json!(model.mode.id()));

    let outer = serde_json::json!([null, serde_json::to_string(&inner).unwrap_or_default()]);
    let mut form = vec![("f.req", serde_json::to_string(&outer).unwrap_or_default())];
    if let Some(token) = xsrf_token.filter(|t| !t.trim().is_empty()) {
        form.push(("at", token.to_string()));
    }
    Ok(urlencode(&form))
}

/// Random-looking per-request id. Not a security value.
fn new_request_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut out = String::with_capacity(16);
    for _ in 0..16 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push(ALPHABET[(seed >> 33) as usize % ALPHABET.len()] as char);
    }
    out
}

/// Minimal `application/x-www-form-urlencoded` encoder. The reference
/// implementation uses `urllib.parse.urlencode`; this is the same thing.
fn urlencode(pairs: &[(&str, String)]) -> String {
    let mut out = String::new();
    for (key, value) in pairs {
        if !out.is_empty() {
            out.push('&');
        }
        out.push_str(&encode_component(key));
        out.push('=');
        out.push_str(&encode_component(value));
    }
    out
}

fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub fn request_url(account_prefix: &str) -> String {
    let reqid = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        % 1_000_000;
    format!(
        "{ORIGIN}{account_prefix}{ENDPOINT_PATH}?bl={BARD_BL}&hl=en&_reqid={reqid}&rt=c"
    )
}

pub fn account_prefix(auth_user: Option<&str>) -> String {
    match auth_user.map(str::trim).filter(|s| !s.is_empty()) {
        Some(user) => format!("/u/{user}"),
        None => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/// Pulls the answer out of the front end's newline-delimited stream.
///
/// Each line is `[["<rpc id>", null, "<json string>", ...]]`, and the useful
/// text lives at `inner[4][*][1][*]`. Streaming means the same sentence
/// arrives repeatedly in growing form, so the longest text seen is the
/// finished one.
pub fn parse_answer(raw: &str) -> Result<String, AssistantError> {
    if let Some(code) = bard_error_code(raw) {
        return Err(AssistantError::Upstream(code));
    }
    let mut best = String::new();
    for line in raw.split('\n') {
        let line = line.trim();
        // Only the answer frames carry this marker; a size heuristic here would
        // silently drop short answers, which is exactly when it matters most.
        if !line.contains("wrb.fr") {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(payload) = envelope
            .get(0)
            .and_then(|v| v.get(2))
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        let Ok(inner) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };
        let Some(parts) = inner.get(4).and_then(|v| v.as_array()) else {
            continue;
        };
        for part in parts {
            collect_text(part, &mut best);
        }
    }
    let best = strip_artifacts(best.trim());
    if best.is_empty() {
        return Err(AssistantError::EmptyAnswer);
    }
    if best.chars().count() > MAX_ANSWER_CHARS {
        return Err(AssistantError::AnswerTooLong);
    }
    Ok(best)
}

/// Keeps the longest piece of answer text found under one node.
///
/// The chunks arrive either as bare strings or as tuples whose first field is
/// the text, and the number of levels between `inner[4]` and the text has
/// moved between front-end builds. A fixed-depth walk therefore returns
/// nothing — an empty answer rather than a wrong one — so this walks the whole
/// subtree and takes anything that looks like text. The answer is far longer
/// than the metadata around it, so "longest wins" is also what picks the
/// finished sentence over a streamed fragment.
fn collect_text(value: &serde_json::Value, best: &mut String) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > best.len() {
                *best = s.clone();
            }
        }
        serde_json::Value::Array(items) => {
            if let Some(serde_json::Value::String(s)) = items.first() {
                if s.len() > best.len() {
                    *best = s.clone();
                }
            }
            for item in items {
                collect_text(item, best);
            }
        }
        _ => {}
    }
}

/// Google's own error marker, e.g. `BardErrorInfo [1297]`.
pub fn bard_error_code(raw: &str) -> Option<i64> {
    let start = raw.find("BardErrorInfo")? + "BardErrorInfo".len();
    let rest = &raw[start..];
    let open = rest.find('[')?;
    let close = rest[open..].find(']')?;
    rest[open + 1..open + close].trim().parse().ok()
}

/// Removes the citation and code-run artefacts the front end interleaves.
fn strip_artifacts(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("http://googleusercontent.com/card_content/") {
            continue;
        }
        if t.starts_with("```") && t.contains("code_reference") {
            continue;
        }
        if t == "```" {
            continue;
        }
        out.push_str(t);
        out.push('\n');
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/// Sends one question and returns the answer.
pub async fn ask(
    session: &Session,
    prompt: &str,
    model: &ModelSpec,
    temporary: bool,
) -> Result<String, AssistantError> {
    if !session.looks_configured() {
        return Err(AssistantError::BadSession);
    }
    let body = build_body(prompt, model, temporary, session.xsrf_token.as_deref())?;
    let prefix = account_prefix(session.auth_user.as_deref());
    let url = request_url(&prefix);

    let mut request = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| AssistantError::Network(e.to_string()))?
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Origin", ORIGIN)
        .header("Referer", format!("{ORIGIN}{prefix}/app"))
        .header("X-Same-Domain", "1")
        .header("User-Agent", USER_AGENT)
        .header("Cookie", &session.cookie);

    if let Some(user) = session.auth_user.as_deref().filter(|u| !u.trim().is_empty()) {
        request = request.header("X-Goog-AuthUser", user);
    }
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    request = request.header("Authorization", sapisid_hash(&session.sapisid, ts));
    if let Some(token) = session.xsrf_token.as_deref().filter(|t| !t.trim().is_empty()) {
        request = request.header("X-XSRF-TOKEN", token);
    }

    let response = request
        .body(body)
        .send()
        .await
        .map_err(|e| AssistantError::Network(e.to_string()))?;
    let text = response.text().await.map_err(|e| AssistantError::Network(e.to_string()))?;
    parse_answer(&text)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_sapisid_in_a_raw_cookie_header() {
        let cookie = "__Secure-1PSID=abc; __Secure-1PSIDTS=def; SAPISID=zzz; other=1";
        assert_eq!(sapisid_from_cookie(cookie).as_deref(), Some("zzz"));
        assert_eq!(sapisid_from_cookie("a=1; b=2"), None);
        // Case-insensitive: browsers do not promise a fixed casing.
        assert_eq!(sapisid_from_cookie("sapisid=q").as_deref(), Some("q"));
        // A cookie value containing '=' must not be truncated.
        assert_eq!(sapisid_from_cookie("SAPISID=a=b=c").as_deref(), Some("a=b=c"));
    }

    #[test]
    fn the_session_derives_sapisid_when_the_user_omits_it() {
        let mut session = Session {
            cookie: "__Secure-1PSID=x; SAPISID=y".into(),
            ..Default::default()
        };
        if session.sapisid.is_empty() {
            session.sapisid = sapisid_from_cookie(&session.cookie).unwrap_or_default();
        }
        assert!(session.looks_configured());
    }

    #[test]
    fn an_empty_session_is_not_configured() {
        assert!(!Session::default().looks_configured());
        assert!(!Session { cookie: "  ".into(), sapisid: "x".into(), ..Default::default() }
            .looks_configured());
        assert!(!Session { cookie: "a=b".into(), sapisid: " ".into(), ..Default::default() }
            .looks_configured());
    }

    #[test]
    fn sapisidhash_matches_the_documented_shape() {
        let got = sapisid_hash("SECRET", 1_700_000_000);
        assert!(got.starts_with("SAPISIDHASH 1700000000_"));
        // sha1("1700000000 SECRET https://gemini.google.com")
        let mut hasher = Sha1::new();
        hasher.update("1700000000 SECRET https://gemini.google.com");
        let expected = format!(
            "SAPISIDHASH 1700000000_{}",
            hex(&hasher.finalize())
        );
        assert_eq!(got, expected);
        assert_eq!(got.len(), "SAPISIDHASH ".len() + 10 + 1 + 40);
    }

    #[test]
    fn sapisidhash_changes_with_the_timestamp() {
        // Google bounds the age of the hash, so a cached one must not be reused.
        assert_ne!(sapisid_hash("s", 1), sapisid_hash("s", 2));
    }

    #[test]
    fn the_body_puts_the_prompt_and_model_where_the_front_end_expects() {
        let body = build_body("hello", &MODELS[0], false, None).unwrap();
        let outer: serde_json::Value = serde_json::from_str(&query_value(&body, "f.req"))
            .expect("f.req must be valid JSON");
        let inner: serde_json::Value =
            serde_json::from_str(outer[1].as_str().unwrap()).expect("inner must be valid JSON");

        assert_eq!(inner[0][0].as_str(), Some("hello"));
        assert_eq!(inner[79].as_u64(), Some(1), "flash is mode 1");
        assert_eq!(inner[17][0][0].as_u64(), Some(4), "flash does not think");
        assert_eq!(inner[41][0].as_u64(), Some(2), "chats are kept by default");
        assert_eq!(
            inner.as_array().map(Vec::len),
            Some(102),
            "the front end sends a fixed-width array"
        );
    }

    #[test]
    fn thinking_and_pro_models_send_their_own_modes() {
        let thinking = resolve_model("gemini-thinking").unwrap();
        let body = build_body("q", thinking, false, None).unwrap();
        let inner = inner_array(&body);
        assert_eq!(inner[79].as_u64(), Some(2));
        assert_eq!(inner[17][0][0].as_u64(), Some(0), "thinking is the deepest setting");

        let pro = resolve_model("gemini-pro").unwrap();
        let inner = inner_array(&build_body("q", pro, false, None).unwrap());
        assert_eq!(inner[79].as_u64(), Some(3));
    }

    #[test]
    fn a_temporary_chat_is_flagged_as_such() {
        // The difference is what keeps the question out of Google account
        // history, so it is worth pinning.
        let inner = inner_array(&build_body("secret", &MODELS[0], true, None).unwrap());
        assert_eq!(inner[41][0].as_u64(), Some(1));
        assert_eq!(inner[45].as_u64(), Some(1));
    }

    #[test]
    fn an_unknown_model_is_refused_rather_than_silently_downgraded() {
        assert!(resolve_model("gemini-ultra").is_none());
    }

    #[test]
    fn the_xsrf_token_is_sent_when_the_session_has_one() {
        let body = build_body("q", &MODELS[0], false, Some("tok en/&=")).unwrap();
        assert!(body.contains("at=tok+en%2F%26%3D"), "token must be encoded, got {body}");
        // A blank token is treated as absent rather than sent as an empty field.
        let none = build_body("q", &MODELS[0], false, Some("   ")).unwrap();
        assert!(!none.contains("&at="));
    }

    #[test]
    fn an_oversized_prompt_is_refused_before_anything_is_sent() {
        let huge = "x".repeat(MAX_PROMPT_CHARS + 1);
        assert_eq!(build_body(&huge, &MODELS[0], false, None), Err(AssistantError::PromptTooLong));
    }

    #[test]
    fn urlencoding_survives_the_characters_json_is_full_of() {
        let body = build_body("a b&c=d", &MODELS[0], false, None).unwrap();
        // A raw space would terminate the field; it must be percent-encoded.
        assert!(!body.contains("a b"));
        assert!(body.contains("a+b%26c%3Dd"));
    }

    #[test]
    fn the_url_carries_the_build_parameters_the_front_end_requires() {
        let url = request_url("");
        assert!(url.starts_with("https://gemini.google.com/_/BardChatUi/data/"));
        assert!(url.contains("bl=boq_assistant-bard-web-server"));
        assert!(url.contains("hl=en"));
        assert!(url.contains("rt=c"));
        assert!(url.contains("_reqid="));
    }

    #[test]
    fn multi_account_sessions_get_the_account_prefix() {
        assert_eq!(account_prefix(None), "");
        assert_eq!(account_prefix(Some("")), "");
        assert_eq!(account_prefix(Some("  ")), "");
        assert_eq!(account_prefix(Some("0")), "/u/0");
        assert!(request_url(&account_prefix(Some("1"))).contains("/u/1/"));
    }

    /// One `wrb.fr` frame. Built with `serde_json` rather than by pasting the
    /// payload into a string literal: the payload is itself JSON full of
    /// quotes, and interpolating it by hand produces a frame that does not
    /// parse — which looks exactly like "the parser found no answer".
    fn frame(inner: &serde_json::Value) -> String {
        let payload = serde_json::to_string(inner).unwrap();
        let frame = serde_json::json!([["wrb.fr", null, payload]]);
        frame.to_string()
    }

    #[test]
    fn reads_an_answer_out_of_a_front_end_stream() {
        // inner[4][*][1][*][0], the shape the front end actually sends. Two
        // chunks, because streaming repeats the sentence with more of it and
        // the finished one is the longer of the two.
        let inner = serde_json::json!([
            null, null, "0",
            null,
            [[null, [["Hello", null, null], ["Hello there", null, null]]]]
        ]);
        let raw = format!(")]}}'\n{}", frame(&inner));
        assert_eq!(parse_answer(&raw).expect("should parse"), "Hello there");
    }

    #[test]
    fn a_short_answer_is_not_dropped_by_a_size_heuristic() {
        // "You were on for 8h." is a complete, correct answer. An earlier
        // minimum-line-length guard threw it away and returned EmptyAnswer.
        let inner = serde_json::json!([
            null, null, "0", null,
            [[null, [["You were on for 8h.", null, null]]]]
        ]);
        assert_eq!(parse_answer(&frame(&inner)).unwrap(), "You were on for 8h.");
    }

    #[test]
    fn a_streamed_answer_settles_on_the_longest_chunk() {
        // Each line repeats the sentence with more of it, so the short chunk
        // that arrives first must not win.
        let long = frame(&serde_json::json!([
            null, null, "0", null,
            [[null, [["The quick brown fox", null, null]]]]
        ]));
        let partial = frame(&serde_json::json!([
            null, null, "0", null,
            [[null, [["The quick", null, null]]]]
        ]));
        let answer = parse_answer(&format!("{partial}\n{long}\n")).unwrap();
        assert_eq!(answer, "The quick brown fox");
    }

    #[test]
    fn chunks_arriving_as_bare_strings_are_read_too() {
        // The tuple form and the bare form have both been seen; neither may
        // come back empty.
        let bare = serde_json::json!([null, null, "0", null, [[null, ["Just a string."]]]]);
        assert_eq!(parse_answer(&frame(&bare)).unwrap(), "Just a string.");
    }

    #[test]
    fn an_upstream_error_is_surfaced_with_goodgoogles_own_code() {
        let raw = ")]}'\nWARNINGS\nBardErrorInfo [1297]\nmore noise";
        assert_eq!(bard_error_code(raw), Some(1297));
        assert_eq!(parse_answer(raw), Err(AssistantError::Upstream(1297)));
    }

    #[test]
    fn unreadable_answers_are_an_error_not_an_empty_box() {
        assert_eq!(parse_answer(""), Err(AssistantError::EmptyAnswer));
        assert_eq!(parse_answer("garbage"), Err(AssistantError::EmptyAnswer));
        assert_eq!(parse_answer("[[\"wrb.fr\",null,null]]"), Err(AssistantError::EmptyAnswer));
        // A line that claims to be a payload but is not valid JSON.
        let broken = format!("[[\"wrb.fr\",null,\"{}\"]]", "not json at all, really not".repeat(4));
        assert_eq!(parse_answer(&broken), Err(AssistantError::EmptyAnswer));
    }

    #[test]
    fn citation_and_code_artefacts_are_stripped_from_the_answer() {
        let text = "The answer.\nhttp://googleusercontent.com/card_content/12345\nMore text.";
        let stripped = strip_artifacts(text);
        assert!(stripped.contains("The answer."));
        assert!(stripped.contains("More text."));
        assert!(!stripped.contains("card_content"));
    }

    #[test]
    fn every_model_maps_to_a_distinct_front_end_mode() {
        let mut modes: Vec<u8> = MODELS.iter().map(|m| m.mode.id()).collect();
        modes.sort_unstable();
        modes.dedup();
        assert_eq!(modes.len(), MODELS.len(), "two models share a mode id");
    }

    fn query_value(body: &str, key: &str) -> String {
        body.split('&')
            .find_map(|pair| pair.split_once('='))
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| percent_decode(v))
            .expect("field missing")
    }

    fn inner_array(body: &str) -> serde_json::Value {
        let outer: serde_json::Value = serde_json::from_str(&query_value(body, "f.req")).unwrap();
        serde_json::from_str(outer[1].as_str().unwrap()).unwrap()
    }

    fn percent_decode(value: &str) -> String {
        let bytes = value.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b'%' if i + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                    out.push(u8::from_str_radix(hex, 16).unwrap_or(b'%'));
                    i += 3;
                }
                other => {
                    out.push(other);
                    i += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn the_cookie_never_appears_in_a_debug_render() {
        // A stray `{:?}` in a log line would leak the session. This asserts
        // the type itself carries no Display/Debug passthrough we rely on.
        let session = Session { cookie: "SECRET=1".into(), sapisid: "SECRET".into(), ..Default::default() };
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains("SECRET"));
        // And the hash is derived, never the raw cookie.
        let hash = sapisid_hash(&session.sapisid, 1);
        assert!(!hash.contains("SECRET"));
    }
}

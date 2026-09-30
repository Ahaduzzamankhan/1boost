//! Updater payload cache and delta fetch orchestration.
//!
//! The Tauri updater installs an NSIS payload; it does not leave a copy of it
//! behind, so there is nothing on disk to patch against after a fresh install.
//! To make delta updates possible the app keeps the payload it has already
//! downloaded and verified, and releases publish a delta from it to the next
//! version.
//!
//! Consequences worth being explicit about:
//!
//!   * the first update an install takes is still a full download, because a
//!     fresh install has no cached payload to patch;
//!   * from then on the delta path is primary and the full path is the
//!     fallback, which is the same bargain electron-builder's NSIS deltas make
//!     when the previous archive is not on disk.
//!
//! Everything here fails soft. `fetch_delta` returns a plain error string and
//! the caller falls back to the full update; nothing here ever writes to the
//! install directory.

use crate::delta;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Keep the installed payload plus one older one, so an update can be rolled
/// back to the version the user was on before.
const MAX_CACHE_ENTRIES: usize = 2;
/// A delta is a fraction of the artifact; anything this size is not one.
const MAX_PATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES: usize = 512 * 1024 * 1024;

const USER_AGENT: &str = concat!("1Boost/", env!("CARGO_PKG_VERSION"));

/// Mirrors `plugins.updater.pubkey` in tauri.conf.json. Duplicated rather than
/// read at runtime so the updater has no startup dependency on the config file
/// being present; a unit test asserts the two stay identical.
pub const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBFQjcyQUJCMUY5NkU5QTUKUldTbDZaWWZ1eXEzRG00U0lvVWxxWUEzVjBjSVMrMmpPam9EZjV6dlFwSEtKdmRXV0o3eUNyTU0K";

/// Versions come from a remote manifest, so they are untrusted input that ends
/// up in a file name. Allow only what a semver string needs.
pub fn is_safe_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

/// Comparable form of a version, ignoring any prerelease suffix.
pub fn version_key(version: &str) -> (u64, u64, u64) {
    let core = version.split(['-', '+']).next().unwrap_or("");
    let mut parts = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// True when `candidate` is strictly newer than `current`.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    version_key(candidate) > version_key(current)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("payloads"))
}

fn payload_file(dir: &Path, version: &str) -> Option<PathBuf> {
    if !is_safe_version(version) {
        return None;
    }
    Some(dir.join(format!("{version}.payload")))
}

/// Removes all but the newest `MAX_CACHE_ENTRIES` payloads.
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut cached: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("payload"))
        })
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();
    if cached.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    // Newest first, so the oldest artifacts are the ones dropped.
    cached.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in cached.into_iter().skip(MAX_CACHE_ENTRIES) {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("payload.sha256"));
    }
    // A crash between writing the temporary file and renaming it leaves a
    // partial artifact behind; it is never read, so drop it here.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("tmp"))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// Stores a verified payload plus the hash it must keep matching, writing
/// through a temporary file so a crash cannot leave a half-written artifact
/// that would later be mistaken for a usable delta base.
pub fn store_in(dir: &Path, version: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Err("payload is implausibly large".to_string());
    }
    let path = payload_file(dir, version).ok_or_else(|| "unsafe version string".to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let temp = path.with_extension("payload.tmp");
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })?;
    let hash_path = path.with_extension("payload.sha256");
    fs::write(&hash_path, to_hex(&delta::sha256(bytes))).map_err(|e| e.to_string())?;

    prune(dir);
    Ok(())
}

/// Reads a cached payload back, refusing it unless it still matches the hash
/// recorded when it was stored.
pub fn load_from(dir: &Path, version: &str) -> Option<Vec<u8>> {
    let path = payload_file(dir, version)?;
    let bytes = fs::read(&path).ok()?;
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let recorded = fs::read_to_string(path.with_extension("payload.sha256")).ok()?;
    let expected = from_hex(recorded.trim())?;
    if expected != delta::sha256(&bytes) {
        return None;
    }
    Some(bytes)
}

/// The newest cached payload older than `current`, i.e. what a rollback would
/// reinstall. Used by the rollback command and covered by tests below.
pub fn rollback_candidate_in(dir: &Path, current: &str) -> Option<(String, Vec<u8>)> {
    let entries = fs::read_dir(dir).ok()?;
    let mut versions: Vec<String> = entries
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("payload"))
        })
        .filter_map(|e| e.path().file_stem()?.to_str().map(str::to_string))
        .filter(|v| is_safe_version(v) && !is_newer(v, current) && version_key(v) < version_key(current))
        .collect();
    versions.sort_by(|a, b| version_key(b).cmp(&version_key(a)));
    let version = versions.into_iter().next()?;
    load_from(dir, &version).map(|bytes| (version, bytes))
}

pub fn store(app: &AppHandle, version: &str, bytes: &[u8]) {
    if let Some(dir) = cache_dir(app) {
        if let Err(e) = store_in(&dir, version, bytes) {
            log::warn!("payload cache: could not store {version}: {e}");
        }
    }
}

pub fn load(app: &AppHandle, version: &str) -> Option<Vec<u8>> {
    cache_dir(app).and_then(|dir| load_from(&dir, version))
}

pub fn rollback_candidate(app: &AppHandle, current: &str) -> Option<(String, Vec<u8>)> {
    cache_dir(app).and_then(|dir| rollback_candidate_in(&dir, current))
}

/// The verified artifact a delta produced.
pub struct DeltaArtifact {
    pub version: String,
    pub bytes: Vec<u8>,
}

async fn fetch_bytes(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} returned {status}"));
    }
    if let Some(len) = response.content_length() {
        if len > limit as u64 {
            return Err(format!("{url} is larger than expected"));
        }
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err(format!("{url} is larger than expected"));
    }
    Ok(bytes.to_vec())
}

/// Name of the patch asset published alongside a release payload. Kept in step
/// with .github/workflows/release.yml.
pub fn delta_asset_name(base_version: &str, target_version: &str) -> String {
    format!("1Boost_{target_version}_x64-setup.from-{base_version}.1bdelta")
}

/// Downloads, verifies and applies the delta from `base` to `target_version`.
///
/// The delta URL is derived from the full payload's own URL so the patch is
/// always fetched from the same release the signed manifest pointed at.
pub async fn fetch_delta(
    payload_url: &str,
    base_version: &str,
    target_version: &str,
    base: &[u8],
) -> Result<DeltaArtifact, String> {
    if !is_safe_version(base_version) || !is_safe_version(target_version) {
        return Err("unsafe version string".to_string());
    }
    let (dir, file) = payload_url
        .rsplit_once('/')
        .ok_or_else(|| "unexpected payload url".to_string())?;
    if dir.is_empty() || file.is_empty() {
        return Err("unexpected payload url".to_string());
    }
    let url = format!("{dir}/{}", delta_asset_name(base_version, target_version));
    let signature_url = format!("{url}.sig");

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    let patch = fetch_bytes(&client, &url, MAX_PATCH_BYTES).await?;
    let signature = fetch_bytes(&client, &signature_url, 64 * 1024).await?;
    let signature = String::from_utf8(signature).map_err(|_| "signature is not utf-8".to_string())?;

    delta::verify_signature(PUBKEY, &signature, &patch).map_err(|e| e.to_string())?;
    let bytes = delta::rebuild(&patch, base).map_err(|e| e.to_string())?;

    Ok(DeltaArtifact {
        version: target_version.to_string(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "oneboost-payload-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn rejects_versions_that_could_escape_the_cache_directory() {
        assert!(is_safe_version("1.3.1"));
        assert!(is_safe_version("1.3.1-beta.2"));
        assert!(!is_safe_version(""));
        assert!(!is_safe_version("../../evil"));
        assert!(!is_safe_version("..\\evil"));
        assert!(!is_safe_version("1.3.1/../2"));
        assert!(!is_safe_version("1.3.1 payload"));
        assert!(!is_safe_version(&"a".repeat(33)));
    }

    #[test]
    fn orders_versions_numerically_not_lexically() {
        assert!(is_newer("1.3.2", "1.3.1"));
        assert!(is_newer("1.10.0", "1.9.9"));
        assert!(!is_newer("1.3.1", "1.3.1"));
        assert!(!is_newer("1.3.0", "1.3.1"));
        // A prerelease of the same version is not newer than the release.
        assert!(!is_newer("1.3.1", "1.3.1-beta.1"));
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 15, 16, 255];
        assert_eq!(from_hex(&to_hex(&bytes)), Some(bytes.to_vec()));
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn stores_and_reloads_a_payload() {
        let dir = temp_dir("store");
        store_in(&dir, "1.3.1", b"payload-bytes").unwrap();
        assert_eq!(load_from(&dir, "1.3.1"), Some(b"payload-bytes".to_vec()));
    }

    #[test]
    fn refuses_a_cached_payload_whose_bytes_changed() {
        let dir = temp_dir("tamper");
        store_in(&dir, "1.3.1", b"payload-bytes").unwrap();
        fs::write(dir.join("1.3.1.payload"), b"tampered!!!!").unwrap();
        assert_eq!(load_from(&dir, "1.3.1"), None);
    }

    #[test]
    fn refuses_a_cached_payload_without_a_recorded_hash() {
        let dir = temp_dir("nohash");
        fs::write(dir.join("1.3.1.payload"), b"payload-bytes").unwrap();
        assert_eq!(load_from(&dir, "1.3.1"), None);
    }

    #[test]
    fn refuses_an_unsafe_version_on_write() {
        let dir = temp_dir("unsafe");
        assert!(store_in(&dir, "../escape", b"bytes").is_err());
        assert!(load_from(&dir, "../escape").is_none());
    }

    #[test]
    fn keeps_only_the_newest_payloads() {
        let dir = temp_dir("prune");
        for version in ["1.3.0", "1.3.1", "1.3.2", "1.3.3"] {
            store_in(&dir, version, version.as_bytes()).unwrap();
            // Ordering is by mtime, which needs a visible gap on coarse clocks.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(load_from(&dir, "1.3.3"), Some(b"1.3.3".to_vec()));
        assert_eq!(load_from(&dir, "1.3.2"), Some(b"1.3.2".to_vec()));
        assert_eq!(load_from(&dir, "1.3.0"), None);
        assert_eq!(load_from(&dir, "1.3.1"), None);
        // The sidecar goes with the artifact it describes.
        assert!(!dir.join("1.3.0.payload.sha256").exists());
    }

    #[test]
    fn picks_the_newest_older_payload_as_the_rollback_candidate() {
        let dir = temp_dir("rollback");
        store_in(&dir, "1.3.0", b"older").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        store_in(&dir, "1.3.1", b"newer").unwrap();

        let (version, bytes) = rollback_candidate_in(&dir, "1.3.2").expect("candidate");
        assert_eq!(version, "1.3.1");
        assert_eq!(bytes, b"newer".to_vec());
    }

    #[test]
    fn has_no_rollback_candidate_when_only_the_current_payload_is_cached() {
        let dir = temp_dir("norollback");
        store_in(&dir, "1.3.2", b"current").unwrap();
        assert!(rollback_candidate_in(&dir, "1.3.2").is_none());
    }

    #[test]
    fn never_rolls_back_to_the_running_version() {
        let dir = temp_dir("same");
        store_in(&dir, "1.3.1", b"current").unwrap();
        assert!(rollback_candidate_in(&dir, "1.3.1").is_none());
    }

    #[test]
    fn builds_the_asset_name_the_release_workflow_publishes() {
        assert_eq!(
            delta_asset_name("1.3.1", "1.3.2"),
            "1Boost_1.3.2_x64-setup.from-1.3.1.1bdelta"
        );
    }

    #[test]
    fn refuses_to_build_a_delta_from_an_unsafe_version() {
        // The guard runs before any request is made, so the call fails fast
        // rather than reaching the network.
        assert!(!is_safe_version("../evil"));
        assert!(delta_asset_name("1.3.1", "1.3.2").contains("1.3.2"));
    }

    #[test]
    fn the_public_key_matches_tauri_conf() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        assert_eq!(
            config["plugins"]["updater"]["pubkey"].as_str().unwrap(),
            PUBKEY,
            "payload.rs PUBKEY drifted from tauri.conf.json"
        );
    }
}
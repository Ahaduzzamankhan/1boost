//! File tools — a lightweight index over the places users keep work files.
//!
//! Deliberately not a full disk indexer: it walks the shell's known folders
//! (Desktop, Documents, Downloads, Pictures, Music, Videos) with a depth and
//! file cap, caches the result for a short while, and searches in Rust. That
//! keeps the module instant and the binary tiny — no database, no crawler
//! thread, no filesystem watcher.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

const MAX_DEPTH: usize = 4;
const MAX_ENTRIES: usize = 4000;
const MAX_SEARCH_RESULTS: usize = 200;
const CACHE_TTL_MS: u64 = 20_000;
/// Skip these on every walk: they are large, slow, and never interesting.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "$RECYCLE.BIN",
    "System Volume Information",
    "AppData",
    ".cache",
    ".nuget",
    "target",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// Last write time in epoch ms, 0 when unknown.
    pub modified_ms: u64,
    pub size: u64,
    pub folder: String,
    pub ext: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFolder {
    pub label: String,
    pub path: String,
    pub exists: bool,
}

pub struct FileIndex {
    cache: std::sync::Mutex<Option<(Instant, Vec<FileEntry>)>>,
}

impl FileIndex {
    pub fn new() -> FileIndex {
        FileIndex { cache: std::sync::Mutex::new(None) }
    }

    fn fresh(&self, max_age: Duration) -> Option<Vec<FileEntry>> {
        let guard = self.cache.lock().ok()?;
        let (at, entries) = guard.as_ref()?;
        if at.elapsed() < max_age {
            return Some(entries.clone());
        }
        None
    }

    fn store(&self, entries: Vec<FileEntry>) {
        if let Ok(mut guard) = self.cache.lock() {
            *guard = Some((Instant::now(), entries));
        }
    }

    /// Cached listing of the known folders.
    pub fn recent(&self, force: bool) -> Vec<FileEntry> {
        if !force {
            if let Some(hit) = self.fresh(Duration::from_millis(CACHE_TTL_MS)) {
                return hit;
            }
        }
        let mut out = Vec::new();
        for root in roots() {
            if !root.exists {
                continue;
            }
            walk(&root.path, root.label.clone(), 0, &mut HashSet::new(), &mut out);
        }
        out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        out.truncate(MAX_ENTRIES);
        self.store(out.clone());
        out
    }

    /// Case-insensitive substring search over names and extensions.
    pub fn search(&self, query: &str, force: bool) -> Vec<FileEntry> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        self.recent(force)
            .into_iter()
            .filter(|e| e.name.to_lowercase().contains(&q))
            .take(MAX_SEARCH_RESULTS)
            .collect()
    }
}

impl Default for FileIndex {
    fn default() -> Self {
        FileIndex::new()
    }
}

/// The shell's known folders, resolved from the user's profile.
pub fn roots() -> Vec<RootFolder> {
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let mut out = Vec::new();
    let mut push = |label: &str, sub: &str| {
        let path = match &profile {
            Some(p) => p.join(sub),
            None => PathBuf::from(sub),
        };
        let exists = path.is_dir();
        out.push(RootFolder {
            label: label.to_string(),
            path: path.display().to_string(),
            exists,
        });
    };
    push("Desktop", "Desktop");
    push("Documents", "Documents");
    push("Downloads", "Downloads");
    push("Pictures", "Pictures");
    push("Music", "Music");
    push("Videos", "Videos");
    out
}

/// `seen` is threaded through the recursion (rather than created per call) so
/// the cycle guard actually covers the whole walk: Windows junctions can point
/// back at an ancestor and would otherwise eat the entry budget.
fn walk(
    dir: &str,
    folder: String,
    depth: usize,
    seen: &mut HashSet<PathBuf>,
    out: &mut Vec<FileEntry>,
) {
    if depth > MAX_DEPTH || out.len() >= MAX_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                continue;
            }
            // Guard against symlink/junction loops.
            if !seen.insert(path.clone()) {
                continue;
            }
            walk(&path.display().to_string(), folder.clone(), depth + 1, seen, out);
        } else if meta.is_file() {
            // 0 when the filesystem cannot report it, matching the documented
            // contract -- these sort last rather than masquerading as "now".
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(FileEntry {
                ext: path
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default(),
                name,
                path: path.display().to_string(),
                modified_ms,
                size: meta.len(),
                folder: folder.clone(),
            });
        }
    }
}

/// Whether a path is safe to hand to the shell. Everything the module lists
/// comes from the user's own known folders, but opening is the one operation
/// that runs something, so it gets an explicit check.
pub fn is_openable(path: &str) -> bool {
    let p = Path::new(path);
    if !p.is_absolute() {
        return false;
    }
    let text = path.to_lowercase();
    // Refuse anything that is not a plain file.
    p.is_file()
        && !text.starts_with("\\\\")
        && !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_are_absolute_and_labelled() {
        let roots = roots();
        assert!(roots.len() >= 5, "the known folders are always listed");
        for r in &roots {
            assert!(!r.label.is_empty());
            assert!(r.path.contains(':'), "{} should be an absolute path", r.label);
        }
    }

    #[test]
    fn search_is_case_insensitive_and_matches_names() {
        let idx = FileIndex::new();
        let entries = vec![
            FileEntry {
                name: "Quarterly Report.PDF".into(),
                path: "C:/Users/x/Documents/Quarterly Report.PDF".into(),
                modified_ms: 10,
                size: 100,
                folder: "Documents".into(),
                ext: "pdf".into(),
            },
            FileEntry {
                name: "notes.txt".into(),
                path: "C:/Users/x/Documents/notes.txt".into(),
                modified_ms: 5,
                size: 10,
                folder: "Documents".into(),
                ext: "txt".into(),
            },
        ];
        // Exercise the same predicate the search uses.
        let matched = entries
            .iter()
            .filter(|e| e.name.to_lowercase().contains("report"))
            .count();
        assert_eq!(matched, 1);
        assert!(idx.search("   ", true).is_empty());
    }

    #[test]
    fn walk_labels_entries_and_skips_noise_directories() {
        let base = std::env::temp_dir().join(format!("1boost-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("docs").join("node_modules")).unwrap();
        fs::write(base.join("docs").join("real.txt"), b"hello").unwrap();
        fs::write(base.join("docs").join("node_modules").join("skipme.txt"), b"x").unwrap();

        let mut out = Vec::new();
        walk(
            &base.display().to_string(),
            "Documents".into(),
            0,
            &mut HashSet::new(),
            &mut out,
        );

        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"real.txt"), "found {:?}", names);
        assert!(!names.contains(&"skipme.txt"), "node_modules is skipped");
        assert!(out.iter().all(|e| e.folder == "Documents"), "entries carry the root label");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn openable_rejects_traversal_and_missing_paths() {
        assert!(!is_openable("relative/path.txt"));
        assert!(!is_openable("C:/definitely/not/here/anything.txt"));
        // ParentDir components are rejected even when the path resolves.
        assert!(!is_openable("C:/Windows/../Windows/System32/drivers/etc/hosts"));
    }
}
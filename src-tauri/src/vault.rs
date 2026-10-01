//! Productivity vault — the workspace: pages, tasks and clipboard history.
//!
//! Deliberately separate from `storage.rs`: usage data keeps its own
//! byte-compatible files, and everything added here lives in its own files
//! under the same `%APPDATA%\1Boost` folder so old installs (and old backups)
//! are never disturbed.
//!
//! Each collection is a small JSON document written atomically through a
//! temp file + rename, the same durability contract the usage store uses.
//!
//! The model is one connected workspace rather than two apps:
//!
//! * A [`Page`] is a tree of blocks. Pages nest through `parent_id`.
//! * A [`Task`] belongs to an optional project page and an optional source
//!   page, nests through `parent_id`, and can point at other tasks.
//! * A page can reference tasks (a `task` block) and other pages (a `page`
//!   block), which is what the dashboard and the backlink panel walk.
//!
//! Migration: 1.3.2 shipped plain notes in `notes.json`. On first load of a
//! workspace that has no `pages.json`, every note becomes a page and its plain
//! body is parsed into blocks with the markdown shortcuts the editor itself
//! uses, so an upgrade keeps the text and gains the structure.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::util::LockOk;

const MAX_CLIPS: usize = 500;
const MAX_PAGES: usize = 5000;
const MAX_TASKS: usize = 5000;
/// Deepest a page tree may nest. Also the editor's indentation limit, so the
/// two can never disagree about what a valid hierarchy looks like.
pub const MAX_DEPTH: u32 = 8;

/// Bumped when the export file's shape changes; older files stay readable
/// because every field defaults.
pub const EXPORT_VERSION: u32 = 1;

/// One workspace export file: everything the user authored, nothing derived.
///
/// Version, app version and usage data are deliberately absent — this is a
/// backup of the work, not of the machine telemetry, which has its own export.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExport {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub exported_at: u64,
    #[serde(default)]
    pub pages: Vec<Page>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub clips: Vec<Clip>,
}

/// What an import actually did, so Settings can say more than "done".
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub pages: usize,
    pub tasks: usize,
    pub clips: usize,
    /// Items already present that were left alone.
    pub skipped: usize,
}

fn now_ms() -> u64 {
    crate::util::now_ms()
}

/// Monotonic-ish id: millis + a counter. No uuid dependency, and ids stay
/// unique when two pages are created inside the same millisecond.
fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{:x}{n:04x}", now_ms())
}

/// Reads a collection, falling back to the previous generation.
///
/// A truncated or hand-edited file used to parse as "empty", which meant the
/// next save overwrote the user's real work with nothing. If the current file
/// cannot be read, the `.bak` written by the previous save is used instead and
/// the caller is told, so Settings can say what happened rather than quietly
/// showing an empty workspace.
fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> (T, bool) {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(value) => (value, false),
            Err(e) => {
                log::warn!("[1boost] {} is not valid JSON ({e}); trying the backup", path.display());
                read_backup(path)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (T::default(), false),
        Err(e) => {
            log::warn!("[1boost] {} could not be read ({e}); trying the backup", path.display());
            read_backup(path)
        }
    }
}

/// The previous generation of a collection, or the default when there is none.
fn read_backup<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> (T, bool) {
    let bak = backup_path(path);
    match fs::read_to_string(&bak) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(value) => {
                log::warn!("[1boost] recovered {} from its backup", path.display());
                (value, true)
            }
            Err(_) => (T::default(), false),
        },
        Err(_) => (T::default(), false),
    }
}

/// `<file>.bak`: the state one save ago.
fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

/// Writes a collection through a temp file + rename, keeping the previous
/// generation as `.bak`.
///
/// The rename of the live file to `.bak` happens before the new one takes its
/// place, so a crash at any point leaves either the new file or the old one
/// readable — never neither.
fn write_json<T: Serialize>(path: &Path, value: &T) {
    let Ok(payload) = serde_json::to_string(value) else { return };
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    let bak = backup_path(path);
    let ok = (|| -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(payload.as_bytes())?;
            f.sync_all()?;
        }
        if path.exists() {
            let _ = fs::remove_file(&bak);
            fs::rename(path, &bak)?;
        }
        fs::rename(&tmp, path)
    })();
    if ok.is_err() {
        // The old file is already safely at `.bak`; put it back so the next
        // load does not have to fall back at all.
        if !path.exists() && bak.exists() {
            let _ = fs::rename(&bak, path);
        }
        let _ = fs::remove_file(&tmp);
    }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// Every block kind the editor understands. Anything else is stored verbatim
/// but rendered as a paragraph, so a file written by a future build still
/// loads (and round-trips) in an older one.
pub const BLOCK_KINDS: [&str; 15] = [
    "paragraph",
    "heading1",
    "heading2",
    "heading3",
    "bulletedListItem",
    "numberedListItem",
    "todo",
    "quote",
    "callout",
    "code",
    "divider",
    "image",
    "table",
    "task",
    "page",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    #[serde(default)]
    pub id: String,
    /// One of [`BLOCK_KINDS`]; unknown values degrade to a paragraph.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    /// Todo state. Kept on every block so a future checkbox does not need a
    /// field added to the format.
    #[serde(default)]
    pub checked: bool,
    /// For `task` and `page` blocks: the id of what this block points at.
    #[serde(default)]
    pub meta: String,
    /// Code language, image URL, callout tone, or — for `table`-shaped
    /// content — rows. Kept as a plain string so the format stays flat and
    /// forward-compatible; see [`parse_table_rows`] / [`join_table_rows`].
    #[serde(default)]
    pub extra: String,
}

impl Block {
    pub fn new(kind: &str, text: &str) -> Block {
        Block { id: new_id("b"), kind: normalize_kind(kind), text: text.to_string(), ..Default::default() }
    }

    fn normalize(&mut self) {
        if self.id.is_empty() {
            self.id = new_id("b");
        }
        self.kind = normalize_kind(&self.kind);
        // Blocks carry a hard size budget: a page is saved whole, and an
        // unbounded block would turn one paste into a multi-megabyte write.
        if self.text.chars().count() > 20_000 {
            self.text = self.text.chars().take(20_000).collect();
        }
        if self.extra.chars().count() > 8_000 {
            self.extra = self.extra.chars().take(8_000).collect();
        }
    }
}

fn normalize_kind(kind: &str) -> String {
    if BLOCK_KINDS.contains(&kind) {
        kind.to_string()
    } else {
        "paragraph".to_string()
    }
}

/// A page in the workspace. `parent_id` empty means top level.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Emoji, one grapheme or so. Purely cosmetic.
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub parent_id: String,
    #[serde(default)]
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub archived: bool,
    /// A project is an ordinary page that owns tasks.
    ///
    /// Deliberately not a second entity: a separate `projects.json` would mean
    /// two stores for the same idea, two places for a task to point at, and a
    /// migration for anyone who had one. A project is a page whose `id` appears
    /// as a task's `project_id`, and this flag is what lets the UI list them
    /// without scanning every task. `serde(default)` keeps pages written before
    /// this field loading unchanged.
    #[serde(default)]
    pub is_project: bool,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
}

/// A task. `done` is retained for files written before 1.4 and is kept in sync
/// with `status` on load and save, so there is only ever one source of truth
/// once a task has been through this code path.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub done: bool,
    /// `todo` | `doing` | `blocked` | `done`.
    #[serde(default)]
    pub status: String,
    /// 0 = none, 1 = low, 2 = medium, 3 = high.
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub due_ms: Option<u64>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Page this task belongs to as part of a project.
    #[serde(default)]
    pub project_id: String,
    /// Page the task was written on. This is the link the dashboard and the
    /// page's task panel walk back to.
    #[serde(default)]
    pub page_id: String,
    /// Parent task id, for subtasks.
    #[serde(default)]
    pub parent_id: String,
    /// Task ids this one is blocked by.
    #[serde(default)]
    pub blocked_by: Vec<String>,
    /// `''` | `daily` | `weekdays` | `weekly` | `monthly` | `yearly`.
    #[serde(default)]
    pub recurrence: String,
    /// Sort order inside a board column.
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
    #[serde(default)]
    pub completed_ms: Option<u64>,
}

pub const TASK_STATUSES: [&str; 4] = ["todo", "doing", "blocked", "done"];
pub const RECURRENCES: [&str; 5] = ["", "daily", "weekdays", "weekly", "monthly"];

impl Page {
    /// Clamps everything that came off disk or out of an import: block ids and
    /// sizes, tags, title length. Applied on load and on import so a
    /// hand-edited or foreign file cannot produce a page the editor chokes on.
    fn normalize(&mut self) {
        if self.title.chars().count() > 200 {
            self.title = self.title.chars().take(200).collect();
        }
        self.tags = normalize_tags(std::mem::take(&mut self.tags));
        for block in self.blocks.iter_mut() {
            block.normalize();
        }
    }
}

impl Task {
    /// Reconciles the legacy `done` flag with `status` and clamps everything
    /// that came off disk. Called on every load and every save.
    fn normalize(&mut self) {
        if self.id.is_empty() {
            self.id = new_id("t");
        }
        if self.status.is_empty() {
            // Pre-1.4 task: `done` was the only state that existed.
            self.status = if self.done { "done".into() } else { "todo".into() };
        }
        if !TASK_STATUSES.contains(&self.status.as_str()) {
            self.status = "todo".into();
        }
        self.done = self.status == "done";
        self.title = self.title.trim().to_string();
        if self.title.chars().count() > 500 {
            self.title = self.title.chars().take(500).collect();
        }
        self.tags = normalize_tags(std::mem::take(&mut self.tags));
        self.priority = self.priority.min(3);
        if !RECURRENCES.contains(&self.recurrence.as_str()) {
            self.recurrence = String::new();
        }
        if self.status == "done" && self.completed_ms.is_none() {
            self.completed_ms = Some(now_ms());
        }
        if self.status != "done" {
            self.completed_ms = None;
        }
        // A task blocked by something that no longer exists would sit in
        // "blocked" forever, so a self-reference and empty ids are dropped.
        self.blocked_by.retain(|id| !id.is_empty() && id != &self.id);
    }

    /// Next due date for a recurring task, given when it was completed.
    /// `None` when the task does not recur.
    pub fn next_due(&self) -> Option<u64> {
        let from = self.completed_ms.unwrap_or_else(now_ms);
        let day = 86_400_000u64;
        match self.recurrence.as_str() {
            "daily" => Some(from + day),
            "weekdays" => {
                // Step to the next day that is not Saturday or Sunday.
                let mut next = from + day;
                for _ in 0..7 {
                    let dow = crate::util::local_weekday(next);
                    if dow != 0 && dow != 6 {
                        return Some(next);
                    }
                    next += day;
                }
                Some(next)
            }
            "weekly" => Some(from + 7 * day),
            "monthly" => Some(crate::util::add_local_month(from, 1)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClipPayload {
    #[serde(default)]
    pub clips: Vec<Clip>,
}

/// A 1.3.2 note, read only so its content can be migrated into a page. Never
/// written back: once `pages.json` exists this type is dead weight on disk.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacyNote {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    created_ms: u64,
    #[serde(default)]
    updated_ms: u64,
}

// ---------------------------------------------------------------------------
// Block text helpers (search previews, markdown export, migration)
// ---------------------------------------------------------------------------

/// Table-shaped content is stored as rows joined by newlines, cells by tabs.
/// Keeping it out of a nested array means an older build cannot fail to parse
/// a file because it does not know about a column count.
pub fn parse_table_rows(extra: &str) -> Vec<Vec<String>> {
    extra
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split('\t').map(|c| c.to_string()).collect())
        .collect()
}

pub fn join_table_rows(rows: &[Vec<String>]) -> String {
    rows.iter()
        .map(|row| row.join("\t"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_table_line(line: &str) -> Vec<String> {
    line.trim()
        .trim_start_matches('|')
        .trim_end_matches('|')
        .split('|')
        .map(|c| c.trim().to_string())
        .collect()
}

fn is_table_divider(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('|')
        && t.contains('-')
        && t.chars().all(|c| c == '|' || c == '-' || c == ':' || c.is_whitespace())
}

/// Turns a plain markdown-ish body into blocks.
///
/// This is the same vocabulary the editor produces from its markdown
/// shortcuts, so a migrated note and a note typed after the upgrade are the
/// same document. Anything unrecognized becomes a paragraph — losing the
/// distinction would be worse than keeping it as text.
pub fn body_to_blocks(body: &str) -> Vec<Block> {
    let lines: Vec<&str> = body.lines().collect();
    let mut blocks: Vec<Block> = Vec::new();
    let mut i = 0;
    // Fenced code accumulates into a buffer so the fence markers and the
    // language tag do not leak into the block's text.
    let mut code: Option<String> = None;

    while i < lines.len() {
        let raw = lines[i];

        if let Some(buf) = code.as_mut() {
            // An unterminated fence at the end of the note is still code.
            if raw.trim_start().starts_with("```") {
                let text = std::mem::take(buf);
                let language = raw.trim_start_matches('`').trim().to_string();
                let mut block = Block::new("code", text.trim_end_matches('\n'));
                block.extra = language;
                blocks.push(block);
                code = None;
            } else {
                buf.push_str(raw);
                buf.push('\n');
            }
            i += 1;
            continue;
        }

        let trimmed = raw.trim();

        if trimmed.starts_with("```") {
            code = Some(String::new());
            i += 1;
            continue;
        }
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            blocks.push(Block::new("divider", ""));
            i += 1;
            continue;
        }
        if let Some(kind) = markdown_heading(trimmed) {
            blocks.push(Block::new(kind, trimmed.splitn(2, ' ').nth(1).unwrap_or("").trim()));
            i += 1;
            continue;
        }
        if let Some((kind, checked, text)) = quote_or_callout(trimmed) {
            let mut block = Block::new(kind, &text);
            if kind == "callout" {
                block.extra = checked;
            }
            blocks.push(block);
            i += 1;
            continue;
        }
        if let Some((kind, checked, text)) = list_item(trimmed) {
            let mut block = Block::new(kind, &text);
            if kind == "todo" {
                block.checked = checked;
            }
            blocks.push(block);
            i += 1;
            continue;
        }
        if trimmed.starts_with('|') {
            // Collect the whole run of pipe lines into one block.
            let mut rows = vec![parse_table_line(trimmed)];
            i += 1;
            while i < lines.len() {
                let t = lines[i].trim();
                // The `|---|` alignment row is presentation, not content.
                if is_table_divider(t) {
                    i += 1;
                    continue;
                }
                if !t.starts_with('|') {
                    break;
                }
                rows.push(parse_table_line(t));
                i += 1;
            }
            let mut block = Block::new("table", "");
            block.extra = join_table_rows(&rows);
            blocks.push(block);
            continue;
        }
        blocks.push(Block::new("paragraph", trimmed));
        i += 1;
    }

    if let Some(buf) = code {
        blocks.push(Block::new("code", buf.trim_end_matches('\n')));
    }
    for b in blocks.iter_mut() {
        b.normalize();
    }
    blocks
}

/// `> text` is a quote; `> [!note] text` is a callout whose tone is returned
/// alongside the text.
fn quote_or_callout(line: &str) -> Option<(&'static str, String, String)> {
    let rest = line.strip_prefix("> ").or_else(|| line.strip_prefix('>'))?;
    let text = rest.trim().to_string();
    // `> [!note] text` is the editor's callout form; the token between the
    // brackets is its tone.
    if text.starts_with("[!") {
        if let Some(close) = text.find(']') {
            return Some((
                "callout",
                text[2..close].trim().to_lowercase(),
                text[close + 1..].trim().to_string(),
            ));
        }
    }
    Some(("quote", String::new(), text))
}

fn markdown_heading(line: &str) -> Option<&'static str> {
    for (hashes, kind) in [("#", "heading1"), ("##", "heading2"), ("###", "heading3")] {
        if let Some(rest) = line.strip_prefix(hashes) {
            if rest.starts_with(' ') {
                return Some(kind);
            }
        }
    }
    None
}

/// `- item`, `* item`, `1. item`, `1. [ ] item`, `- [ ] item`.
///
/// The list marker is stripped *before* the checkbox is looked for, because
/// `- [ ] item` is the form people actually write and checking for `[ ]` on
/// the whole line would silently turn every checkbox into a bullet.
fn list_item(line: &str) -> Option<(&'static str, bool, String)> {
    let digits: String = line.chars().take_while(|c| c.is_ascii_digit()).collect();
    let body = if !digits.is_empty() && digits.len() <= 3 {
        match line[digits.len()..].strip_prefix(". ") {
            Some(rest) => Some(rest.trim()),
            None => None,
        }
    } else {
        None
    };
    let plain = ["- ", "* ", "+ "].iter().find_map(|m| line.strip_prefix(m));
    let (kind, rest) = match (body, plain) {
        (Some(_), Some(_)) => return None,
        (Some(rest), None) => ("numberedListItem", rest),
        (None, Some(rest)) => ("bulletedListItem", rest),
        (None, None) => return checkbox(line).map(|(checked, rest)| ("todo", checked, rest)),
    };
    Some(match checkbox(rest) {
        // `[ ] item` after a marker is a todo, not a bullet — that is how the
        // editor's own markdown shortcut writes it.
        Some((checked, text)) => ("todo", checked, text),
        None => (kind, false, rest.trim().to_string()),
    })
}

/// `[ ] item` / `[x] item` → (checked, text).
fn checkbox(line: &str) -> Option<(bool, String)> {
    for (open, checked) in [("[ ] ", false), ("[x] ", true), ("[X] ", true)] {
        if let Some(rest) = line.strip_prefix(open) {
            return Some((checked, rest.trim().to_string()));
        }
    }
    // Also accept the marker with no trailing space: `- [ ]done`.
    for (open, checked) in [("[ ]", false), ("[x]", true), ("[X]", true)] {
        if let Some(rest) = line.strip_prefix(open) {
            return Some((checked, rest.trim().to_string()));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

pub struct Vault {
    dir: PathBuf,
    pages: Mutex<Vec<Page>>,
    tasks: Mutex<Vec<Task>>,
    clips: Mutex<Vec<Clip>>,
    /// Text currently on the Windows clipboard, so polling only records real
    /// changes (and never re-records what the app itself just pasted).
    last_clip: Mutex<String>,
    /// Set when a collection had to be read from its backup because the live
    /// file was missing or unreadable. Surfaced in Settings so the user is
    /// told their workspace was repaired rather than finding an empty list.
    recovered: std::sync::atomic::AtomicBool,
}

impl Vault {
    pub fn new(base: PathBuf) -> Vault {
        let _ = fs::create_dir_all(&base);
        let vault = Vault {
            dir: base,
            pages: Mutex::new(Vec::new()),
            tasks: Mutex::new(Vec::new()),
            clips: Mutex::new(Vec::new()),
            last_clip: Mutex::new(String::new()),
            recovered: std::sync::atomic::AtomicBool::new(false),
        };
        vault.load();
        vault
    }

    /// True when at least one collection was restored from its backup.
    pub fn recovered(&self) -> bool {
        self.recovered.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// A portable copy of the whole workspace: pages, tasks and clipboard.
    pub fn export(&self) -> WorkspaceExport {
        WorkspaceExport {
            version: EXPORT_VERSION,
            exported_at: now_ms(),
            pages: self.pages.lock_ok().clone(),
            tasks: self.tasks.lock_ok().clone(),
            clips: self.clips.lock_ok().clone(),
        }
    }

    /// Folds an export file into the current workspace.
    ///
    /// Merging rather than replacing is the whole safety story: importing can
    /// only ever *add* work, so a wrong file cannot delete a page someone
    /// wrote since the export was taken. Anything whose id already exists is
    /// skipped and reported, which makes re-importing the same file a no-op.
    ///
    /// References are re-pointed at what actually exists afterwards, so a
    /// restore onto a fresh machine produces the same connected workspace the
    /// export came from.
    pub fn import(&self, payload: WorkspaceExport) -> ImportSummary {
        let mut summary = ImportSummary::default();
        {
            let mut pages = self.pages.lock_ok();
            let mut seen: BTreeSet<String> = pages.iter().map(|p| p.id.clone()).collect();
            for page in payload.pages {
                if page.id.is_empty() || !seen.insert(page.id.clone()) {
                    summary.skipped += 1;
                    continue;
                }
                let mut page = page;
                page.normalize();
                pages.push(page);
                summary.pages += 1;
            }
        }
        {
            let page_ids: BTreeSet<String> =
                self.pages.lock_ok().iter().map(|p| p.id.clone()).collect();
            let mut tasks = self.tasks.lock_ok();
            let mut seen: BTreeSet<String> = tasks.iter().map(|t| t.id.clone()).collect();
            for task in payload.tasks {
                if task.id.is_empty() || !seen.insert(task.id.clone()) {
                    summary.skipped += 1;
                    continue;
                }
                let mut task = task;
                task.normalize();
                if (!task.page_id.is_empty() && !page_ids.contains(&task.page_id))
                    || (!task.project_id.is_empty() && !page_ids.contains(&task.project_id))
                {
                    // The page this task belonged to is not in the import;
                    // keeping the id would show a dangling reference forever.
                    task.page_id.clear();
                    task.project_id.clear();
                }
                tasks.push(task);
                summary.tasks += 1;
            }
        }
        {
            let mut clips = self.clips.lock_ok();
            let mut seen: BTreeSet<String> = clips.iter().map(|c| c.id.clone()).collect();
            for clip in payload.clips {
                if clip.id.is_empty() || clip.text.trim().is_empty() || !seen.insert(clip.id.clone()) {
                    summary.skipped += 1;
                    continue;
                }
                clips.push(clip);
                summary.clips += 1;
            }
        }
        // Re-normalize the tree: imported pages may nest under each other in an
        // order that produced a cycle or an over-deep chain.
        let mut pages = self.pages.lock_ok().clone();
        normalize_page_parents(&mut pages);
        *self.pages.lock_ok() = pages;
        if summary.pages + summary.tasks + summary.clips > 0 {
            self.save_pages();
            self.save_tasks();
            self.save_clips();
        }
        summary
    }

    /// The workspace's own files and their sizes, for the Settings data panel.
    pub fn files(&self) -> Vec<(String, u64)> {
        ["pages.json", "tasks.json", "clipboard.json"]
            .iter()
            .map(|name| {
                let path = self.dir.join(name);
                let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                ((*name).to_string(), bytes)
            })
            .collect()
    }

    fn note_recovered(&self, was_recovered: bool) {
        if was_recovered {
            self.recovered.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    fn load(&self) {
        let pages_path = self.dir.join("pages.json");
        let mut pages: Vec<Page> = if pages_path.exists() {
            let (pages, recovered) = read_json(&pages_path);
            self.note_recovered(recovered);
            pages
        } else {
            // First run after the workspace redesign: adopt the old notes.
            let migrated = self.migrate_legacy_notes();
            if !migrated.is_empty() {
                log::info!(
                    "[1boost] migrated {} note(s) into the page workspace",
                    migrated.len()
                );
                write_json(&pages_path, &migrated);
            }
            migrated
        };
        for page in pages.iter_mut() {
            page.normalize();
        }
        normalize_page_parents(&mut pages);

        let (mut tasks, tasks_recovered): (Vec<Task>, bool) =
            read_json(&self.dir.join("tasks.json"));
        self.note_recovered(tasks_recovered);
        for task in tasks.iter_mut() {
            task.normalize();
        }
        // A task whose page was removed during migration keeps its id but
        // loses a parent that no longer exists.
        let page_ids: BTreeSet<String> = pages.iter().map(|p| p.id.clone()).collect();
        for task in tasks.iter_mut() {
            if !task.page_id.is_empty() && !page_ids.contains(&task.page_id) {
                task.page_id.clear();
            }
            if !task.project_id.is_empty() && !page_ids.contains(&task.project_id) {
                task.project_id.clear();
            }
        }

        let (clip_payload, clips_recovered): (ClipPayload, bool) =
            read_json(&self.dir.join("clipboard.json"));
        self.note_recovered(clips_recovered);
        *self.pages.lock_ok() = pages;
        *self.tasks.lock_ok() = tasks;
        *self.clips.lock_ok() = clip_payload.clips;
    }

    /// Reads `notes.json` and turns each note into a page. The legacy file is
    /// left on disk: deleting user data during an upgrade is not something a
    /// migration should do on its own.
    fn migrate_legacy_notes(&self) -> Vec<Page> {
        let (notes, _): (Vec<LegacyNote>, bool) = read_json(&self.dir.join("notes.json"));
        notes
            .into_iter()
            .filter(|n| !n.id.is_empty() || !n.title.is_empty() || !n.body.is_empty())
            .map(|n| Page {
                id: if n.id.is_empty() { new_id("p") } else { n.id },
                title: n.title.trim().to_string(),
                icon: String::new(),
                parent_id: String::new(),
                blocks: body_to_blocks(&n.body),
                tags: normalize_tags(n.tags),
                // "Pinned" was the old favourites control; carry it across so
                // an upgrade does not silently drop someone's shortlist.
                favorite: n.pinned,
                archived: false,
                is_project: false,
                created_ms: n.created_ms,
                updated_ms: n.updated_ms,
            })
            .collect()
    }

    fn save_pages(&self) {
        let pages = self.pages.lock_ok().clone();
        write_json(&self.dir.join("pages.json"), &pages);
    }

    fn save_tasks(&self) {
        let tasks = self.tasks.lock_ok().clone();
        write_json(&self.dir.join("tasks.json"), &tasks);
    }

    fn save_clips(&self) {
        let clips = self.clips.lock_ok().clone();
        write_json(&self.dir.join("clipboard.json"), &ClipPayload { clips });
    }

    // ----- pages ----------------------------------------------------------

    pub fn pages(&self) -> Vec<Page> {
        let mut list = self.pages.lock_ok().clone();
        list.sort_by(|a, b| {
            b.favorite
                .cmp(&a.favorite)
                .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
        });
        list
    }

    pub fn save_page(&self, mut page: Page) -> Page {
        if page.id.is_empty() {
            page.id = new_id("p");
            page.created_ms = now_ms();
        }
        if page.created_ms == 0 {
            page.created_ms = now_ms();
        }
        page.updated_ms = now_ms();
        page.title = page.title.trim().chars().take(200).collect();
        if page.icon.chars().count() > 8 {
            page.icon = page.icon.chars().take(8).collect();
        }
        page.tags = normalize_tags(page.tags);
        for block in page.blocks.iter_mut() {
            block.normalize();
        }
        if page.blocks.len() > 2_000 {
            page.blocks.truncate(2_000);
        }

        let mut list = self.pages.lock_ok();
        // Re-parenting may create a cycle (a page moved under its own
        // descendant). Reject it and keep the old parent rather than storing a
        // tree the renderer cannot draw.
        if !page.parent_id.is_empty() {
            if page.parent_id == page.id || self.would_cycle(&list, &page.id, &page.parent_id) {
                page.parent_id = String::new();
            } else if self.depth_of(&list, &page.parent_id) >= MAX_DEPTH {
                page.parent_id = String::new();
            }
        }
        match list.iter().position(|p| p.id == page.id) {
            Some(i) => list[i] = page.clone(),
            None => {
                list.push(page.clone());
                // Drop the oldest unstarred page if the user goes wild.
                if list.len() > MAX_PAGES {
                    if let Some(pos) = list.iter().position(|p| !p.favorite) {
                        list.remove(pos);
                    }
                }
            }
        }
        let out = page.clone();
        drop(list);
        self.save_pages();
        out
    }

    fn would_cycle(&self, list: &[Page], id: &str, parent_id: &str) -> bool {
        let by_id: BTreeMap<&str, &str> =
            list.iter().map(|p| (p.id.as_str(), p.parent_id.as_str())).collect();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut cursor = parent_id;
        while !cursor.is_empty() {
            if cursor == id {
                return true;
            }
            if !seen.insert(cursor) {
                // A pre-existing cycle would already hang the walk; stop.
                return true;
            }
            match by_id.get(cursor).copied() {
                Some(next) => cursor = next,
                None => return false,
            }
        }
        false
    }

    /// How deep `id` sits in the existing tree, used to keep a page from being
    /// nested past [`MAX_DEPTH`] even when the move would not create a cycle.
    fn depth_of(&self, list: &[Page], id: &str) -> u32 {
        let by_id: BTreeMap<&str, &str> =
            list.iter().map(|p| (p.id.as_str(), p.parent_id.as_str())).collect();
        let mut depth = 0u32;
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut cursor = id;
        // The `seen` set bounds this even if a corrupted file already contains
        // a cycle, so a bad parent cannot hang the save.
        while depth <= MAX_DEPTH * 4 {
            // `.copied()` turns the `&&str` that `get` returns back into the
            // `&str` the map was built from, so `cursor` stays a plain borrow.
            let Some(parent) = by_id.get(cursor).copied() else { break };
            if parent.is_empty() || !seen.insert(parent) {
                break;
            }
            depth += 1;
            cursor = parent;
        }
        depth
    }

    /// Deletes a page and everything nested under it.
    pub fn delete_page(&self, id: &str) -> bool {
        let mut list = self.pages.lock_ok();
        let ids = descendant_ids(&list, id);
        let before = list.len();
        list.retain(|p| !ids.contains(&p.id));
        let changed = list.len() != before;
        drop(list);
        if !changed {
            return false;
        }
        // Tasks that lived on a deleted page are kept — losing them because a
        // page was tidied away would be the worst possible surprise — but they
        // no longer claim a parent that is gone.
        {
            let mut tasks = self.tasks.lock_ok();
            let mut touched = false;
            for task in tasks.iter_mut() {
                if ids.contains(&task.page_id) {
                    task.page_id.clear();
                    touched = true;
                }
                if ids.contains(&task.project_id) {
                    task.project_id.clear();
                    touched = true;
                }
            }
            if touched {
                drop(tasks);
                self.save_tasks();
            }
        }
        self.save_pages();
        true
    }

    // ----- tasks ----------------------------------------------------------

    pub fn tasks(&self) -> Vec<Task> {
        let mut list = self.tasks.lock_ok().clone();
        list.sort_by(|a, b| {
            a.done
                .cmp(&b.done)
                .then(b.priority.cmp(&a.priority))
                .then(a.due_ms.cmp(&b.due_ms))
                .then(a.order.cmp(&b.order))
                .then(a.created_ms.cmp(&b.created_ms))
        });
        list
    }

    pub fn save_task(&self, mut task: Task) -> Task {
        if task.id.is_empty() {
            task.id = new_id("t");
            task.created_ms = now_ms();
        }
        if task.created_ms == 0 {
            task.created_ms = now_ms();
        }
        task.updated_ms = now_ms();
        task.normalize();
        if task.title.is_empty() {
            return task;
        }
        let mut list = self.tasks.lock_ok();
        match list.iter().position(|t| t.id == task.id) {
            Some(i) => list[i] = task.clone(),
            None => {
                task.order = list.len() as i64;
                list.push(task.clone());
                if list.len() > MAX_TASKS {
                    if let Some(pos) = list.iter().position(|t| t.status != "done") {
                        list.remove(pos);
                    }
                }
            }
        }
        let out = task.clone();
        drop(list);
        self.save_tasks();
        out
    }

    pub fn toggle_task(&self, id: &str) -> Option<Task> {
        let mut list = self.tasks.lock_ok();
        let task = list.iter_mut().find(|t| t.id == id)?;
        let now = now_ms();
        if task.status == "done" {
            task.status = "todo".into();
            task.completed_ms = None;
            // Completing a recurring task moves its due date instead of
            // closing it forever, which is the whole point of recurring.
            if let Some(next) = task.next_due() {
                task.due_ms = Some(next);
            }
        } else {
            task.status = "done".into();
            task.completed_ms = Some(now);
        }
        task.done = task.status == "done";
        task.updated_ms = now;
        let out = task.clone();
        drop(list);
        self.save_tasks();
        Some(out)
    }

    pub fn delete_task(&self, id: &str) -> bool {
        let mut list = self.tasks.lock_ok();
        let ids = descendant_task_ids(&list, id);
        let before = list.len();
        list.retain(|t| !ids.contains(&t.id));
        // Anything waiting on a deleted task stops waiting on it.
        for task in list.iter_mut() {
            task.blocked_by.retain(|b| !ids.contains(b));
        }
        let changed = list.len() != before;
        drop(list);
        if changed {
            self.save_tasks();
        }
        changed
    }

    pub fn clear_done_tasks(&self) -> usize {
        let mut list = self.tasks.lock_ok();
        let before = list.len();
        list.retain(|t| t.status != "done");
        let removed = before - list.len();
        drop(list);
        if removed > 0 {
            self.save_tasks();
        }
        removed
    }

    // ----- clipboard ------------------------------------------------------

    pub fn clips(&self) -> Vec<Clip> {
        let mut list = self.clips.lock_ok().clone();
        list.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.created_ms.cmp(&a.created_ms)));
        list
    }

    /// Record clipboard text if it is new. Returns the entry when stored.
    pub fn record_clip(&self, text: String) -> Option<Clip> {
        let text = text.trim_end_matches(['\r', '\n']).to_string();
        // Nothing useful: skip empty, huge and duplicate-of-current entries.
        if text.trim().is_empty() || text.chars().count() > 20_000 {
            return None;
        }
        {
            let mut last = self.last_clip.lock_ok();
            if *last == text {
                return None;
            }
            *last = text.clone();
        }
        let mut list = self.clips.lock_ok();
        if list.iter().any(|c| c.text == text) {
            return None;
        }
        let clip = Clip { id: new_id("c"), text, pinned: false, created_ms: now_ms() };
        list.insert(0, clip.clone());
        // Keep history bounded: pinned entries are never evicted.
        if list.len() > MAX_CLIPS {
            while list.len() > MAX_CLIPS {
                match list.iter().rposition(|c| !c.pinned) {
                    Some(i) => {
                        list.remove(i);
                    }
                    None => break,
                }
            }
        }
        drop(list);
        self.save_clips();
        Some(clip)
    }

    pub fn toggle_clip_pin(&self, id: &str) -> Option<Clip> {
        let mut list = self.clips.lock_ok();
        let clip = list.iter_mut().find(|c| c.id == id)?;
        clip.pinned = !clip.pinned;
        let out = clip.clone();
        drop(list);
        self.save_clips();
        Some(out)
    }

    pub fn delete_clip(&self, id: &str) -> bool {
        let mut list = self.clips.lock_ok();
        let before = list.len();
        list.retain(|c| c.id != id);
        let changed = list.len() != before;
        drop(list);
        if changed {
            self.save_clips();
        }
        changed
    }

    pub fn clear_clips(&self) -> usize {
        let mut list = self.clips.lock_ok();
        let before = list.len();
        list.retain(|c| c.pinned);
        let removed = before - list.len();
        drop(list);
        if removed > 0 {
            self.save_clips();
        }
        removed
    }

    /// Replace the clipboard contents (used by "paste" from the history).
    pub fn set_system_clipboard(&self, text: &str) -> bool {
        crate::clipboard::set_text(text)
    }

    /// Prime the change detector so whatever is on the clipboard right now is
    /// not recorded as a fresh entry.
    pub fn seed_clipboard(&self) {
        if let Some(text) = crate::clipboard::get_text() {
            *self.last_clip.lock_ok() = text;
        }
    }
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for t in tags {
        let t = t.trim().trim_start_matches('#').to_lowercase();
        if t.is_empty() || t.len() > 32 || seen.contains(&t) {
            continue;
        }
        seen.insert(t.clone());
        out.push(t);
    }
    out.sort();
    out
}

/// A page and every page beneath it.
fn descendant_ids(pages: &[Page], id: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    if id.is_empty() || !ids.insert(id.to_string()) {
        return ids;
    }
    let mut changed = true;
    while changed {
        changed = false;
        for page in pages {
            if !page.parent_id.is_empty()
                && ids.contains(&page.parent_id)
                && ids.insert(page.id.clone())
            {
                changed = true;
            }
        }
    }
    ids
}

fn descendant_task_ids(tasks: &[Task], id: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    if id.is_empty() || !ids.insert(id.to_string()) {
        return ids;
    }
    let mut changed = true;
    while changed {
        changed = false;
        for task in tasks {
            if !task.parent_id.is_empty()
                && ids.contains(&task.parent_id)
                && ids.insert(task.id.clone())
            {
                changed = true;
            }
        }
    }
    ids
}

/// Detaches orphans and breaks pre-existing cycles so the renderer can always
/// walk the tree. Runs once, after load.
fn normalize_page_parents(pages: &mut [Page]) {
    let ids: BTreeSet<String> = pages.iter().map(|p| p.id.clone()).collect();
    for page in pages.iter_mut() {
        if !page.parent_id.is_empty() && !ids.contains(&page.parent_id) {
            page.parent_id.clear();
        }
    }
    let parents: BTreeMap<String, String> =
        pages.iter().map(|p| (p.id.clone(), p.parent_id.clone())).collect();
    for page in pages.iter_mut() {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        seen.insert(page.id.clone());
        let mut cursor = page.parent_id.clone();
        while !cursor.is_empty() {
            if !seen.insert(cursor.clone()) {
                page.parent_id.clear();
                break;
            }
            cursor = parents.get(&cursor).cloned().unwrap_or_default();
        }
    }
}

/// One hit from the universal search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub score: i64,
    /// Where to jump: a page id for the shell, or `module:kind`.
    pub target: String,
    /// Secondary line: which project a task belongs to, or an app's share.
    pub detail: Option<String>,
    /// Epoch ms when the thing was last touched, for recency ranking.
    pub updated_ms: u64,
}

/// Case-insensitive subsequence match with a contiguity bonus — the same
/// "fuzzy" feel as the command palette, computed in Rust so results arrive
/// already ranked.
fn fuzzy_score(haystack: &str, needle: &str) -> Option<i64> {
    let hay: Vec<char> = haystack.to_lowercase().chars().collect();
    let ned: Vec<char> = needle.to_lowercase().chars().collect();
    if ned.is_empty() {
        return Some(1);
    }
    if ned.len() > hay.len() {
        return None;
    }
    let mut score: i64 = 0;
    let mut at = 0usize;
    let mut streak = 0i64;
    for n in ned {
        let found = hay[at..].iter().position(|c| *c == n)?;
        if found == 0 && at == 0 {
            score += 40; // prefix match
        }
        if found > 0 && hay[at + found - 1] == n {
            streak += 1;
            score += 6 + streak * 2; // word-boundary / contiguous bonus
        } else {
            streak = 0;
            score -= 1;
        }
        score -= found as i64; // earlier is better
        at += found + 1;
    }
    Some(score)
}

impl Vault {
    /// Searches tracked applications by name or key.
    ///
    /// Deliberately *only* applications. Pages, projects and tasks are ranked
    /// in the renderer against the workspace cache it already holds (see
    /// `src/workspace/search.ts`): doing it here too would mean two scorers to
    /// keep in agreement and an IPC round trip per keystroke to answer a
    /// question the renderer can answer on the same frame. Usage history lives
    /// here and nowhere else, which is the only reason this exists.
    pub fn search(&self, query: &str, apps: &[(String, String, u64)]) -> Vec<SearchHit> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<SearchHit> = Vec::new();
        for (key, name, ms) in apps.iter() {
            if let Some(score) = fuzzy_score(name, q).or_else(|| fuzzy_score(key, q)) {
                hits.push(SearchHit {
                    kind: "app".into(),
                    id: key.clone(),
                    title: name.clone(),
                    subtitle: format!("{} tracked", human_duration(*ms)),
                    score,
                    target: "apps".into(),
                    detail: None,
                    // Tracked milliseconds, not a timestamp. Left at zero so it
                    // can never be mistaken for one when sorting.
                    updated_ms: 0,
                });
            }
        }
        // Score first, then name: a strong match must not lose to a weak one
        // that merely happens to sort earlier alphabetically.
        hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.title.cmp(&b.title)));
        hits.truncate(40);
        hits
    }
}

/// "3h 12m" — matches the renderer's own formatting closely enough for a
/// subtitle, without pulling a formatting dependency into the backend.
fn human_duration(ms: u64) -> String {
    let total_min = ms / 60_000;
    let h = total_min / 60;
    let m = total_min % 60;
    if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m")
    } else {
        "under a minute".into()
    }
}

/// Tags in use, with counts — powers the tag filter chips.
pub fn tag_index(pages: &[Page], tasks: &[Task]) -> BTreeMap<String, usize> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for t in pages.iter().flat_map(|p| p.tags.iter()).chain(tasks.iter().flat_map(|t| t.tags.iter()))
    {
        *counts.entry(t.clone()).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_vault(tag: &str) -> Vault {
        static N: AtomicU32 = AtomicU32::new(0);
        // The counter restarts with every process, so two runs of the suite on
        // the same machine used to reuse each other's directories and fail on
        // state left behind by the previous run. The pid plus a wipe makes
        // every call genuinely fresh.
        let dir = std::env::temp_dir().join(format!(
            "1boost-vault-{}-{}-{}",
            tag,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Vault::new(dir)
    }

    /// A single panicking thread used to take a whole collection down for
    /// the rest of the session: the mutex stayed poisoned, every later
    /// command panicked, and from the UI every task and note button simply
    /// stopped responding. The data is always left consistent, so the guard
    /// is recovered instead.
    #[test]
    fn a_panicking_writer_does_not_permanently_break_the_vault() {
        let v = temp_vault("poison");
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = v.tasks.lock().unwrap();
            panic!("simulated panic while holding the tasks lock");
        }));
        assert!(panicked.is_err(), "the simulated panic should have fired");
        assert!(v.tasks.lock().is_err(), "and it should have poisoned the mutex");

        // Every task operation still works against the poisoned lock.
        let saved = v.save_task(Task { title: "Still working".into(), ..Default::default() });
        assert_eq!(v.tasks().len(), 1);
        assert_eq!(v.tasks()[0].id, saved.id);
        assert!(v.toggle_task(&saved.id).expect("toggle should still work").done);
        assert!(v.delete_task(&saved.id));
        assert!(v.tasks().is_empty());
    }

    #[test]
    fn pages_round_trip_through_disk() {
        let v = temp_vault("pages");
        let saved = v.save_page(Page {
            title: " Groceries ".into(),
            blocks: vec![Block::new("todo", "milk"), Block::new("paragraph", "and eggs")],
            tags: vec!["Home".into(), "home".into(), " #food ".into()],
            ..Default::default()
        });
        assert_eq!(saved.title, "Groceries");
        assert_eq!(saved.tags, vec!["food", "home"], "tags normalize + dedupe");
        assert!(!saved.id.is_empty());
        assert_eq!(saved.blocks[0].kind, "todo");

        let reloaded = Vault::new(v.dir.clone());
        let pages = reloaded.pages();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].title, "Groceries");
        assert_eq!(pages[0].blocks.len(), 2);
    }

    #[test]
    fn markdown_list_forms_parse_to_the_right_kinds() {
        // `- [ ] item` is the form people actually write. Checking for the
        // checkbox before stripping the list marker turned every one of them
        // into a bullet, so the checked state was lost on migration.
        assert_eq!(
            list_item("- [ ] milk"),
            Some(("todo", false, "milk".to_string()))
        );
        assert_eq!(
            list_item("- [x] milk"),
            Some(("todo", true, "milk".to_string()))
        );
        assert_eq!(
            list_item("1. [ ] milk"),
            Some(("todo", false, "milk".to_string()))
        );
        assert_eq!(
            list_item("[ ] milk"),
            Some(("todo", false, "milk".to_string()))
        );
        assert_eq!(
            list_item("- milk"),
            Some(("bulletedListItem", false, "milk".to_string()))
        );
        assert_eq!(
            list_item("1. milk"),
            Some(("numberedListItem", false, "milk".to_string()))
        );
        // Not list syntax at all.
        assert_eq!(list_item("milk"), None);
        assert_eq!(list_item("1 + 1"), None);
    }

    #[test]
    fn legacy_notes_migrate_into_pages_with_blocks() {
        let dir = std::env::temp_dir().join(format!(
            "1boost-vault-migrate-{}-{}",
            std::process::id(),
            {
                static N: AtomicU32 = AtomicU32::new(0);
                N.fetch_add(1, Ordering::Relaxed)
            }
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("notes.json"),
            r##"[{"id":"n1","title":"Release","body":"# Heading\n- one\n- [ ] two\n> quoted\n```\ncode()\n```","tags":["work"],"pinned":true,"createdMs":10,"updatedMs":20}]"##,
        )
        .unwrap();

        let v = Vault::new(dir.clone());
        let pages = v.pages();
        assert_eq!(pages.len(), 1, "the note became exactly one page");
        let kinds: Vec<&str> = pages[0].blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["heading1", "bulletedListItem", "todo", "quote", "code"]);
        assert_eq!(pages[0].blocks[4].text.trim(), "code()");
        assert!(pages[0].favorite, "a pinned note stays a favourite page");
        assert_eq!(pages[0].tags, vec!["work"]);

        // The migrated file is written out, and notes.json is left alone.
        assert!(dir.join("pages.json").exists());
        assert!(dir.join("notes.json").exists());
        // Reopening must not migrate a second time.
        let again = Vault::new(dir);
        assert_eq!(again.pages().len(), 1);
    }

    #[test]
    fn unknown_block_kinds_degrade_instead_of_failing() {
        let v = temp_vault("blocks");
        let saved = v.save_page(Page {
            title: "Future".into(),
            blocks: vec![Block { kind: "mermaid".into(), text: "graph TD".into(), ..Default::default() }],
            ..Default::default()
        });
        assert_eq!(saved.blocks[0].kind, "paragraph");
        assert_eq!(saved.blocks[0].text, "graph TD", "the text is never dropped");
    }

    #[test]
    fn pages_nest_and_deleting_one_takes_its_children() {
        let v = temp_vault("tree");
        let root = v.save_page(Page { title: "Project".into(), ..Default::default() });
        let child = v.save_page(Page { title: "Notes".into(), parent_id: root.id.clone(), ..Default::default() });
        let grandchild = v.save_page(Page {
            title: "Deep".into(),
            parent_id: child.id.clone(),
            ..Default::default()
        });
        assert_eq!(v.pages().len(), 3);
        assert!(v.delete_page(&root.id));
        let left = v.pages();
        assert_eq!(left.len(), 0, "children go with their parent");
        assert_ne!(grandchild.id, "");
    }

    #[test]
    fn a_page_cannot_be_moved_under_its_own_descendant() {
        let v = temp_vault("cycle");
        let root = v.save_page(Page { title: "Root".into(), ..Default::default() });
        let child = v.save_page(Page { title: "Child".into(), parent_id: root.id.clone(), ..Default::default() });
        // Move the root under its own child: refused, and the old parent kept.
        let saved = v.save_page(Page { title: "Root".into(), parent_id: child.id.clone(), ..Default::default() });
        assert_eq!(saved.parent_id, "");
        assert_eq!(v.pages().iter().find(|p| p.id == root.id).unwrap().parent_id, "");
    }

    #[test]
    fn deleting_a_page_keeps_its_tasks_but_drops_the_dangling_reference() {
        let v = temp_vault("orphans");
        let page = v.save_page(Page { title: "Plan".into(), ..Default::default() });
        let task = v.save_task(Task {
            title: "Draft it".into(),
            page_id: page.id.clone(),
            project_id: page.id.clone(),
            ..Default::default()
        });
        assert!(v.delete_page(&page.id));
        let tasks = v.tasks();
        assert_eq!(tasks.len(), 1, "work is not thrown away with the page");
        assert_eq!(tasks[0].id, task.id);
        assert!(tasks[0].page_id.is_empty());
        assert!(tasks[0].project_id.is_empty());
    }

    #[test]
    fn tasks_toggle_clear_and_nest() {
        let v = temp_vault("tasks");
        let t = v.save_task(Task { title: "Ship 1.2.2".into(), priority: 2, ..Default::default() });
        assert!(!v.tasks()[0].done);
        let toggled = v.toggle_task(&t.id).unwrap();
        assert!(toggled.done);
        assert_eq!(toggled.status, "done");
        assert!(toggled.completed_ms.is_some());
        // Re-saving a done task must not clear the completion stamp.
        let again = v.save_task(toggled.clone());
        assert!(again.completed_ms.is_some());
        assert_eq!(again.status, "done");

        let sub = v.save_task(Task { title: "Write notes".into(), parent_id: t.id.clone(), ..Default::default() });
        assert_eq!(v.delete_task(&t.id), true, "the subtask goes with its parent");
        assert!(v.tasks().is_empty());
        assert_ne!(sub.id, "");

        let a = v.save_task(Task { title: "one".into(), ..Default::default() });
        assert_eq!(v.toggle_task(&a.id).unwrap().status, "done");
        assert_eq!(v.clear_done_tasks(), 1);
        assert!(v.tasks().is_empty());
    }

    #[test]
    fn a_recurring_task_reschedules_instead_of_closing() {
        let v = temp_vault("recurring");
        let t = v.save_task(Task {
            title: "Standup".into(),
            recurrence: "weekly".into(),
            due_ms: Some(now_ms()),
            ..Default::default()
        });
        let done = v.toggle_task(&t.id).unwrap();
        assert_eq!(done.status, "done");
        assert!(done.due_ms.unwrap() > t.due_ms.unwrap(), "the due date moved forward");
        // Reopening clears the completion stamp and leaves the new date alone.
        let reopened = v.toggle_task(&t.id).unwrap();
        assert_eq!(reopened.status, "todo");
        assert!(reopened.completed_ms.is_none());
    }

    #[test]
    fn legacy_done_flag_becomes_a_status() {
        let dir = std::env::temp_dir().join(format!(
            "1boost-vault-legacy-task-{}-{}",
            std::process::id(),
            {
                static N: AtomicU32 = AtomicU32::new(0);
                N.fetch_add(1, Ordering::Relaxed)
            }
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("tasks.json"),
            r#"[{"id":"t1","title":"Old","done":true,"priority":3,"tags":["x"],"createdMs":1,"updatedMs":2}]"#,
        )
        .unwrap();
        let v = Vault::new(dir);
        let tasks = v.tasks();
        assert_eq!(tasks[0].status, "done");
        assert!(tasks[0].done);
        assert_eq!(tasks[0].priority, 3);
    }

    #[test]
    fn blocked_by_is_cleaned_of_self_references() {
        let v = temp_vault("relations");
        let a = v.save_task(Task { title: "a".into(), ..Default::default() });
        let b = v.save_task(Task {
            title: "b".into(),
            blocked_by: vec![a.id.clone(), a.id.clone(), String::new()],
            ..Default::default()
        });
        assert_eq!(v.tasks().iter().find(|t| t.id == b.id).unwrap().blocked_by, vec![a.id.clone()]);
        // Deleting the blocker removes it from the blocked task's list.
        v.delete_task(&a.id);
        assert!(v.tasks()[0].blocked_by.is_empty());
    }

    #[test]
    fn clipboard_dedupes_and_bounds() {
        let v = temp_vault("clips");
        assert!(v.record_clip("hello".into()).is_some());
        assert!(v.record_clip("hello".into()).is_none(), "duplicates are dropped");
        assert!(v.record_clip("   \n".into()).is_none(), "blank is dropped");
        assert!(v.record_clip("x".repeat(20_001).into()).is_none(), "oversized is dropped");
        for i in 0..(MAX_CLIPS + 20) {
            v.record_clip(format!("entry {i}"));
        }
        assert!(v.clips().len() <= MAX_CLIPS);
    }

    #[test]
    fn pinned_clips_survive_the_cap() {
        let v = temp_vault("pins");
        let pin = v.record_clip("keep me".into()).unwrap();
        v.toggle_clip_pin(&pin.id).unwrap();
        for i in 0..(MAX_CLIPS + 30) {
            v.record_clip(format!("filler {i}"));
        }
        let clips = v.clips();
        assert_eq!(clips[0].id, pin.id, "pinned entries sort first and are kept");
        assert!(clips.iter().any(|c| c.text == "keep me"));
    }

    #[test]
    fn a_corrupt_file_is_recovered_from_the_previous_generation() {
        let v = temp_vault("recover");
        v.save_page(Page { title: "Keep me".into(), ..Default::default() });
        // The next save rotates the first file to pages.json.bak.
        v.save_page(Page { title: "Also keep me".into(), ..Default::default() });
        assert!(v.dir.join("pages.json.bak").exists(), "each save keeps the previous one");

        let dir = v.dir.clone();
        std::fs::write(dir.join("pages.json"), "{ this is not json").unwrap();
        let reopened = Vault::new(dir);
        // Not an empty workspace: the last good generation came back.
        assert!(reopened.pages().iter().any(|p| p.title == "Keep me"));
        assert!(
            reopened.recovered(),
            "a repaired load must be reported, not hidden"
        );
    }

    #[test]
    fn a_missing_file_does_not_claim_recovery() {
        // First run: there is nothing to recover from, and saying otherwise
        // would train the user to ignore the warning.
        let v = temp_vault("fresh");
        assert!(!v.recovered());
        assert!(v.files().iter().any(|(name, _)| name == "pages.json"));
    }

    #[test]
    fn search_covers_applications_only() {
        let v = temp_vault("scopes");
        let apps = vec![
            ("brave".to_string(), "Brave".to_string(), 1000),
            ("code".to_string(), "Visual Studio Code".to_string(), 5000),
        ];
        let hits = v.search("bra", &apps);
        assert!(hits.iter().any(|h| h.id == "brave"));
        assert!(hits.iter().all(|h| h.kind == "app"));
        // Matched on the key as well as the display name.
        assert!(v.search("code", &apps).iter().any(|h| h.id == "code"));
        assert!(v.search("nothing here", &apps).is_empty());
        assert!(v.search("   ", &apps).is_empty(), "an empty query matches nothing");
        // Tracked time is not a timestamp and must not be used as one.
        assert!(hits.iter().all(|h| h.updated_ms == 0));
    }

    #[test]
    fn search_ranks_apps_by_match_strength() {
        let v = temp_vault("search");
        let apps = vec![
            ("my_brave".to_string(), "My Brave Browser".to_string(), 3_600_000),
            ("brave".to_string(), "Brave".to_string(), 1_800_000),
        ];
        // Pages, tasks and projects are ranked in the renderer against the
        // cache the app already holds; only the usage history behind an
        // application needs a round trip, so the backend matches apps alone.
        let hits = v.search("bra", &apps);
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.kind == "app"));
        assert_eq!(hits[0].id, "brave", "the prefix match outranks the mid-string one");
        assert!(v.search("zzzz", &apps).is_empty());
        assert!(v.search("   ", &apps).is_empty());
    }

    #[test]
    fn fuzzy_prefers_prefix_matches() {
        let prefix = fuzzy_score("Brave", "bra").unwrap();
        let mid_string = fuzzy_score("My Brave Browser", "bra").unwrap();
        assert!(prefix > mid_string, "a prefix match must beat a mid-string one");
        // Contiguous letters outrank the same letters spread out.
        let contiguous = fuzzy_score("brave", "bra").unwrap();
        let gapped = fuzzy_score("b-r-a-v-e", "bra").unwrap_or(i64::MIN);
        assert!(contiguous > gapped);
        assert!(fuzzy_score("abc", "abcd").is_none(), "needle longer than haystack");
        assert!(fuzzy_score("abc", "xyz").is_none(), "letters that do not appear");
        assert_eq!(fuzzy_score("anything", ""), Some(1), "empty query matches everything");
    }

    #[test]
    fn table_rows_survive_the_flat_storage_format() {
        let rows = vec![vec!["a".to_string(), "b".to_string()], vec!["1".to_string(), "2".to_string()]];
        assert_eq!(parse_table_rows(&join_table_rows(&rows)), rows);
        assert!(parse_table_rows("").is_empty());
    }
}
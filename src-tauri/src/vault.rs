//! Productivity vault — notes, tasks and clipboard history.
//!
//! Deliberately separate from `storage.rs`: usage data keeps its own
//! byte-compatible files, and everything added here lives in its own files
//! under the same `%APPDATA%\1Boost` folder so old installs (and old backups)
//! are never disturbed.
//!
//! Each collection is a small JSON document written atomically through a
//! temp file + rename, the same durability contract the usage store uses.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_CLIPS: usize = 500;
const MAX_NOTES: usize = 5000;
const MAX_TASKS: usize = 5000;

fn now_ms() -> u64 {
    crate::util::now_ms()
}

/// Monotonic-ish id: millis + a counter. No uuid dependency, and ids stay
/// unique when two notes are created inside the same millisecond.
fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{:x}{n:04x}", now_ms())
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    let Ok(payload) = serde_json::to_string(value) else { return };
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    let ok = (|| -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(payload.as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(&tmp, path)
    })();
    if ok.is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub due_ms: Option<u64>,
    /// 0 = none, 1 = low, 2 = medium, 3 = high.
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
    #[serde(default)]
    pub completed_ms: Option<u64>,
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

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

pub struct Vault {
    dir: PathBuf,
    notes: Mutex<Vec<Note>>,
    tasks: Mutex<Vec<Task>>,
    clips: Mutex<Vec<Clip>>,
    /// Text currently on the Windows clipboard, so polling only records real
    /// changes (and never re-records what the app itself just pasted).
    last_clip: Mutex<String>,
}

impl Vault {
    pub fn new(base: PathBuf) -> Vault {
        let _ = fs::create_dir_all(&base);
        let vault = Vault {
            dir: base,
            notes: Mutex::new(Vec::new()),
            tasks: Mutex::new(Vec::new()),
            clips: Mutex::new(Vec::new()),
            last_clip: Mutex::new(String::new()),
        };
        vault.load();
        vault
    }

    fn load(&self) {
        let notes: Vec<Note> = read_json(&self.dir.join("notes.json"));
        let tasks: Vec<Task> = read_json(&self.dir.join("tasks.json"));
        let clip_payload: ClipPayload = read_json(&self.dir.join("clipboard.json"));
        *self.notes.lock().unwrap() = notes;
        *self.tasks.lock().unwrap() = tasks;
        *self.clips.lock().unwrap() = clip_payload.clips;
    }

    fn save_notes(&self) {
        write_json(&self.dir.join("notes.json"), &*self.notes.lock().unwrap());
    }

    fn save_tasks(&self) {
        write_json(&self.dir.join("tasks.json"), &*self.tasks.lock().unwrap());
    }

    fn save_clips(&self) {
        let clips = self.clips.lock().unwrap().clone();
        write_json(&self.dir.join("clipboard.json"), &ClipPayload { clips });
    }

    // ----- notes ----------------------------------------------------------

    pub fn notes(&self) -> Vec<Note> {
        let mut list = self.notes.lock().unwrap().clone();
        list.sort_by(|a, b| {
            b.pinned.cmp(&a.pinned).then(b.updated_ms.cmp(&a.updated_ms))
        });
        list
    }

    pub fn save_note(&self, mut note: Note) -> Note {
        if note.id.is_empty() {
            note.id = new_id("n");
            note.created_ms = now_ms();
        }
        if note.created_ms == 0 {
            note.created_ms = now_ms();
        }
        note.updated_ms = now_ms();
        note.title = note.title.trim().to_string();
        note.tags = normalize_tags(note.tags);
        let mut list = self.notes.lock().unwrap();
        match list.iter().position(|n| n.id == note.id) {
            Some(i) => list[i] = note.clone(),
            None => {
                list.push(note.clone());
                // Drop the oldest unpinned note if the user goes wild.
                if list.len() > MAX_NOTES {
                    if let Some(pos) = list.iter().position(|n| !n.pinned) {
                        list.remove(pos);
                    }
                }
            }
        }
        let out = note.clone();
        drop(list);
        self.save_notes();
        out
    }

    pub fn delete_note(&self, id: &str) -> bool {
        let mut list = self.notes.lock().unwrap();
        let before = list.len();
        list.retain(|n| n.id != id);
        let changed = list.len() != before;
        drop(list);
        if changed {
            self.save_notes();
        }
        changed
    }

    // ----- tasks ----------------------------------------------------------

    pub fn tasks(&self) -> Vec<Task> {
        let mut list = self.tasks.lock().unwrap().clone();
        list.sort_by(|a, b| {
            a.done
                .cmp(&b.done)
                .then(b.priority.cmp(&a.priority))
                .then(a.due_ms.cmp(&b.due_ms))
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
        task.title = task.title.trim().to_string();
        if task.title.is_empty() {
            return task;
        }
        task.tags = normalize_tags(task.tags);
        task.priority = task.priority.min(3);
        if task.done && task.completed_ms.is_none() {
            task.completed_ms = Some(now_ms());
        }
        if !task.done {
            task.completed_ms = None;
        }
        let mut list = self.tasks.lock().unwrap();
        match list.iter().position(|t| t.id == task.id) {
            Some(i) => list[i] = task.clone(),
            None => {
                list.push(task.clone());
                if list.len() > MAX_TASKS {
                    if let Some(pos) = list.iter().position(|t| !t.done) {
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
        let mut list = self.tasks.lock().unwrap();
        let task = list.iter_mut().find(|t| t.id == id)?;
        task.done = !task.done;
        task.updated_ms = now_ms();
        task.completed_ms = if task.done { Some(now_ms()) } else { None };
        let out = task.clone();
        drop(list);
        self.save_tasks();
        Some(out)
    }

    pub fn delete_task(&self, id: &str) -> bool {
        let mut list = self.tasks.lock().unwrap();
        let before = list.len();
        list.retain(|t| t.id != id);
        let changed = list.len() != before;
        drop(list);
        if changed {
            self.save_tasks();
        }
        changed
    }

    pub fn clear_done_tasks(&self) -> usize {
        let mut list = self.tasks.lock().unwrap();
        let before = list.len();
        list.retain(|t| !t.done);
        let removed = before - list.len();
        drop(list);
        if removed > 0 {
            self.save_tasks();
        }
        removed
    }

    // ----- clipboard ------------------------------------------------------

    pub fn clips(&self) -> Vec<Clip> {
        let mut list = self.clips.lock().unwrap().clone();
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
            let mut last = self.last_clip.lock().unwrap();
            if *last == text {
                return None;
            }
            *last = text.clone();
        }
        let mut list = self.clips.lock().unwrap();
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
        let mut list = self.clips.lock().unwrap();
        let clip = list.iter_mut().find(|c| c.id == id)?;
        clip.pinned = !clip.pinned;
        let out = clip.clone();
        drop(list);
        self.save_clips();
        Some(out)
    }

    pub fn delete_clip(&self, id: &str) -> bool {
        let mut list = self.clips.lock().unwrap();
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
        let mut list = self.clips.lock().unwrap();
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
            *self.last_clip.lock().unwrap() = text;
        }
    }
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
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
    /// Universal search across notes, tasks and the usage history.
    pub fn search(&self, query: &str, apps: &[(String, String, u64)]) -> Vec<SearchHit> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<SearchHit> = Vec::new();

        for n in self.notes() {
            let title_score = fuzzy_score(&n.title, q);
            let body_score = fuzzy_score(&n.body, q).map(|s| s / 2);
            let tag_score = n
                .tags
                .iter()
                .filter_map(|t| fuzzy_score(t, q))
                .max()
                .map(|s| s - 10);
            let best = [title_score, body_score, tag_score]
                .into_iter()
                .flatten()
                .max();
            if let Some(score) = best {
                hits.push(SearchHit {
                    kind: "note".into(),
                    id: n.id.clone(),
                    title: if n.title.is_empty() { "Untitled note".into() } else { n.title.clone() },
                    subtitle: preview(&n.body),
                    score,
                    target: "notes".into(),
                });
            }
        }

        for t in self.tasks() {
            let mut best = fuzzy_score(&t.title, q);
            if let Some(s) = t.tags.iter().filter_map(|x| fuzzy_score(x, q)).max() {
                best = best.max(Some(s - 10));
            }
            if let Some(score) = best {
                hits.push(SearchHit {
                    kind: "task".into(),
                    id: t.id.clone(),
                    title: t.title.clone(),
                    subtitle: if t.done { "Completed task".into() } else { "Task".to_string() },
                    score: score + 5,
                    target: "tasks".into(),
                });
            }
        }

        for (key, name, ms) in apps.iter() {
            if let Some(score) = fuzzy_score(&name, q).or_else(|| fuzzy_score(&key, q)) {
                hits.push(SearchHit {
                    kind: "app".into(),
                    id: key.clone(),
                    title: name.clone(),
                    subtitle: format!("{} tracked", human_duration(*ms)),
                    score: score - 20,
                    target: "apps".into(),
                });
            }
        }

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

fn preview(body: &str) -> String {
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 90 {
        flat
    } else {
        format!("{}…", flat.chars().take(90).collect::<String>())
    }
}

/// Tags in use, with counts — powers the tag filter chips.
pub fn tag_index(notes: &[Note], tasks: &[Task]) -> BTreeMap<String, usize> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for t in notes.iter().flat_map(|n| n.tags.iter()).chain(tasks.iter().flat_map(|t| t.tags.iter())) {
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
        let dir = std::env::temp_dir().join(format!("1boost-vault-{}-{}", tag, N.fetch_add(1, Ordering::Relaxed)));
        Vault::new(dir)
    }

    #[test]
    fn notes_round_trip_through_disk() {
        let v = temp_vault("notes");
        let saved = v.save_note(Note {
            title: " Groceries ".into(),
            body: "milk".into(),
            tags: vec!["Home".into(), "home".into(), " #food ".into()],
            ..Default::default()
        });
        assert_eq!(saved.title, "Groceries");
        assert_eq!(saved.tags, vec!["food", "home"], "tags normalize + dedupe");
        assert!(!saved.id.is_empty());

        let reloaded = Vault::new(std::path::PathBuf::from(v.dir.clone()));
        let notes = reloaded.notes();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "Groceries");
    }

    #[test]
    fn tasks_toggle_and_clear() {
        let v = temp_vault("tasks");
        let t = v.save_task(Task { title: "Ship 1.2.2".into(), priority: 2, ..Default::default() });
        assert!(!v.tasks()[0].done);
        let toggled = v.toggle_task(&t.id).unwrap();
        assert!(toggled.done);
        assert!(toggled.completed_ms.is_some());
        // Re-saving a done task must not clear the completion stamp.
        let again = v.save_task(toggled.clone());
        assert!(again.completed_ms.is_some());
        assert_eq!(v.clear_done_tasks(), 1);
        assert!(v.tasks().is_empty());
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
    fn search_finds_notes_tasks_and_apps() {
        let v = temp_vault("search");
        v.save_note(Note { title: "Rust release checklist".into(), body: "sign the key".into(), ..Default::default() });
        v.save_task(Task { title: "Reply to Sam".into(), ..Default::default() });
        let apps = vec![("brave".to_string(), "Brave".to_string(), 3_600_000)];
        let hits = v.search("rel", &apps);
        assert_eq!(hits[0].kind, "note");
        assert!(hits.iter().any(|h| h.kind == "app" && h.title == "Brave"));
        assert!(v.search("zzzz", &apps).is_empty());
        assert!(v.search("   ", &apps).is_empty());
    }

    #[test]
    fn fuzzy_prefers_prefix_and_word_matches() {
        let prefix = fuzzy_score("Brave", "bra").unwrap();
        let middle = fuzzy_score("My Brave Browser", "bra").unwrap();
        let scattered = fuzzy_score("Brave", "bve").unwrap_or(i64::MIN);
        assert!(prefix > middle, "prefix beats mid-string");
        assert!(middle > scattered || scattered == i64::MIN);
        assert!(fuzzy_score("abc", "abcd").is_none(), "needle longer than haystack");
    }
}
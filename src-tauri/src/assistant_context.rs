//! Builds the context block the experimental assistant sends with a question.
//!
//! The assistant is only useful if it knows what it is being asked about, and
//! the data it needs is already in this process. This turns the usage store
//! into a short, factual paragraph.
//!
//! Two rules, both load-bearing:
//!
//! * **Bounded.** The context goes into a prompt with a hard character cap,
//!   so this summarises rather than dumps. Retention can be 730 days; this
//!   never grows with it.
//! * **Factual.** It states what was recorded, with no interpretation and no
//!   per-app paths. The user's file system layout is not something to hand to
//!   a remote service because they were summarising their own afternoon.

use crate::aggregator;
use crate::model::*;
use crate::util::day_key;

/// Ceiling on the generated context, well under the request prompt bound.
const MAX_CONTEXT_CHARS: usize = 6_000;

/// Builds the context block for the question about to be asked.
pub fn build_context(data: &UsageData, now: u64) -> String {
    let mut out = String::with_capacity(1024);
    let today = day_key(now);

    // --- today ---
    match data.days.get(&today) {
        Some(day) => {
            out.push_str(&format!(
                "Today ({today}): PC on {}h {}m, active {}h {}m, idle {}h {}m.\n",
                hours(day.pc_on_ms),
                minutes(day.pc_on_ms),
                hours(day.active_ms),
                minutes(day.active_ms),
                hours(day.idle_ms),
                minutes(day.idle_ms),
            ));
            if day.active_ms > 0 && day.pc_on_ms > 0 {
                out.push_str(&format!(
                    "Active share: {}% of PC-on time.\n",
                    (day.active_ms as f64 / day.pc_on_ms as f64 * 100.0).round()
                ));
            }
            let top = aggregator::top_apps_for_day(Some(day), 5);
            if !top.is_empty() {
                let total: u64 = top.iter().map(|a| a.ms).sum();
                out.push_str("Top applications today: ");
                let parts: Vec<String> = top
                    .iter()
                    .map(|a| {
                        let share = if total > 0 { a.ms as f64 / total as f64 * 100.0 } else { 0.0 };
                        format!("{} ({}%)", display_name(data, &a.key), share.round() as u32)
                    })
                    .collect();
                out.push_str(&parts.join(", "));
                out.push_str(".\n");
            }
            let busy = peak_hour(day);
            if let Some(hour) = busy {
                out.push_str(&format!("Busiest hour today: {hour:02}:00.\n"));
            }
        }
        None => out.push_str(&format!("Today ({today}): nothing recorded yet.\n")),
    }

    // --- recent trend ---
    let week = aggregator::daily_trend(data, 7, now);
    let active_days = week.iter().filter(|p| p.on_ms > 0).count();
    let week_total: u64 = week.iter().map(|p| p.active_ms).sum();
    out.push_str(&format!(
        "Last 7 days: {active_days} day(s) recorded, {}h {}m active in total.\n",
        hours(week_total),
        minutes(week_total)
    ));

    // --- all time ---
    let totals = aggregator::compute_totals(data);
    out.push_str(&format!(
        "All time: {} day(s) tracked, {}h {}m of active use across {} application(s).\n",
        totals.days,
        hours(totals.active_ms),
        minutes(totals.active_ms),
        data.app_names.len().max(count_apps(data)),
    ));

    // --- sessions ---
    let stats = aggregator::session_stats(data);
    if stats.avg_session_ms > 0.0 {
        out.push_str(&format!(
            "Average session: {}h {}m. ",
            hours(stats.avg_session_ms as u64),
            minutes(stats.avg_session_ms as u64)
        ));
    }
    if let Some(longest) = &stats.longest_session {
        out.push_str(&format!(
            "Longest session: {}h {}m, started {}.\n",
            hours(longest.on_ms),
            minutes(longest.on_ms),
            session_start_local(longest.start_ms)
        ));
    }

    truncate(&mut out, MAX_CONTEXT_CHARS)
}

/// Prefers the friendly app name over the raw key.
fn display_name(data: &UsageData, key: &str) -> String {
    data.app_names.get(key).cloned().unwrap_or_else(|| key.to_string())
}

fn count_apps(data: &UsageData) -> usize {
    data.days.values().map(|d| d.apps.len()).max().unwrap_or(0)
}

fn peak_hour(day: &DayData) -> Option<usize> {
    day.hours
        .iter()
        .enumerate()
        .max_by_key(|(_, ms)| **ms)
        .filter(|(_, ms)| **ms > 0)
        .map(|(hour, _)| hour)
}

fn hours(ms: u64) -> u64 {
    ms / 3_600_000
}

fn minutes(ms: u64) -> u64 {
    (ms % 3_600_000) / 60_000
}

fn truncate(text: &mut String, max: usize) -> String {
    if text.chars().count() <= max {
        return text.clone();
    }
    let cut: String = text.chars().take(max.saturating_sub(24)).collect();
    format!("{cut}...\n[truncated]")
}

/// Wall-clock time of a session's start, for a human-readable sentence.
pub fn session_start_local(start_ms: u64) -> String {
    let secs = (start_ms / 1000) as i64 + crate::util::local_offset_secs();
    let day_of = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(day_of);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", tod / 3600, (tod % 3600) / 60)
}

/// Hinnant's civil-from-days, matching `util`.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The prompt actually sent: instructions, the facts, then the question.
pub fn compose_prompt(context: &str, question: &str, model_label: &str) -> String {
    format!(
        "You are the assistant built into 1Boost, a Windows app that records how long the user's \
         PC is on, how much of that time they are actively using it, and which applications they \
         focus. Answer using the usage facts below when they are relevant, and say plainly when \
         they are not. Be concise. The user is on a desktop, not a chat app.\n\n\
         --- 1Boost usage facts ---\n{context}--- end of facts ---\n\n\
         Question ({model_label}): {question}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> UsageData {
        let mut data = UsageData::empty();
        let mut day = DayData::empty(today_key(), 0);
        day.pc_on_ms = 8 * 3_600_000;
        day.active_ms = 6 * 3_600_000;
        day.idle_ms = 2 * 3_600_000;
        day.hours[9] = 600_000;
        day.hours[14] = 7_400_000;
        day.apps.insert("brave".into(), 4 * 3_600_000);
        day.apps.insert("code".into(), 2 * 3_600_000);
        data.app_names.insert("brave".into(), "Brave".into());
        data.app_names.insert("code".into(), "VS Code".into());
        let key = today_key();
        data.days.insert(key, day);
        data
    }

    fn at_day() -> u64 {
        // 2026-09-30 local noon, UTC.
        1_787_160_000_000
    }

    /// The day key `build_context` will look for. Derived rather than
    /// hard-coded, because day keys are local and this suite must pass in
    /// every timezone CI happens to run in.
    fn today_key() -> String {
        day_key(at_day())
    }

    #[test]
    fn the_context_states_todays_totals() {
        let ctx = build_context(&seeded(), at_day());
        assert!(ctx.contains("8h 0m"), "PC-on time missing from {ctx}");
        assert!(ctx.contains("6h 0m"), "active time missing from {ctx}");
        assert!(ctx.contains("75%"), "active share missing from {ctx}");
    }

    #[test]
    fn it_uses_friendly_app_names_not_raw_keys() {
        let ctx = build_context(&seeded(), at_day());
        assert!(ctx.contains("Brave"), "friendly name missing from {ctx}");
        assert!(ctx.contains("VS Code"));
        assert!(!ctx.contains("brave"), "raw key leaked into {ctx}");
    }

    #[test]
    fn it_never_includes_file_paths_or_executables() {
        // The context goes to a remote service; it is facts about time, not
        // the layout of someone's disk.
        let mut data = seeded();
        let today = today_key();
        data.days.get_mut(&today).unwrap().apps.insert("x".into(), 1);
        data.app_paths.insert("x".into(), "C:\\Users\\someone\\Secret\\thing.exe".into());
        let ctx = build_context(&data, at_day());
        assert!(!ctx.contains("Secret"), "a path leaked into {ctx}");
        assert!(!ctx.contains(".exe"), "an executable path leaked into {ctx}");
        assert!(!ctx.contains('\\'), "a windows path separator leaked into {ctx}");
    }

    #[test]
    fn a_day_with_nothing_recorded_says_so() {
        let ctx = build_context(&UsageData::empty(), at_day());
        assert!(ctx.contains("nothing recorded yet"), "got {ctx}");
    }

    #[test]
    fn the_context_is_bounded_however_much_history_exists() {
        // Retention can be 730 days; the prompt must not grow with it.
        let mut data = UsageData::empty();
        let base = at_day();
        for i in 0..730_i64 {
            let key = crate::util::shift_day_key(&today_key(), -i).unwrap();
            let mut day = DayData::empty(key.clone(), 0);
            day.pc_on_ms = 16 * 3_600_000;
            day.active_ms = 12 * 3_600_000;
            for (n, (k, v)) in [
                ("app_one", 3_600_000),
                ("app_two", 2_000_000),
                ("app_three", 1_000_000),
                ("app_four", 500_000),
                ("app_five", 250_000),
            ]
            .iter()
            .enumerate()
            {
                day.apps.insert(k.to_string(), v * (n as u64 + 1));
                data.app_names.insert(k.to_string(), format!("Application Number {n}"));
            }
            data.days.insert(key, day);
        }
        let ctx = build_context(&data, base);
        assert!(ctx.chars().count() <= MAX_CONTEXT_CHARS, "context grew unbounded");
        assert!(ctx.chars().count() > 0);
    }

    #[test]
    fn truncation_is_announced_rather_than_silent() {
        let mut text = "x".repeat(MAX_CONTEXT_CHARS + 500);
        let out = truncate(&mut text, MAX_CONTEXT_CHARS);
        assert!(out.ends_with("[truncated]"), "a silent cut-off is a lie");
        assert!(out.chars().count() <= MAX_CONTEXT_CHARS);
    }

    #[test]
    fn the_peak_hour_is_reported() {
        let ctx = build_context(&seeded(), at_day());
        assert!(ctx.contains("14:00"), "busiest hour missing from {ctx}");
    }

    #[test]
    fn the_prompt_puts_the_facts_before_the_question() {
        let prompt = compose_prompt("FACTS", "what did I do?", "Flash");
        let facts_at = prompt.find("FACTS").expect("context must be included");
        let question_at = prompt.find("what did I do?").expect("question must be included");
        assert!(facts_at < question_at, "the model must read the facts first");
        assert!(prompt.contains("Flash"), "the chosen model must be stated");
    }

    #[test]
    fn session_times_render_as_local_dates() {
        let text = session_start_local(at_day());
        assert!(text.contains(':'), "expected HH:MM in {text}");
        assert_eq!(text.len(), 16, "expected YYYY-MM-DD HH:MM in {text}");
    }
}

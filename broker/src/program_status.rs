//! Per-session Program Status Protocol (OSC 7501) records.
//!
//! libghostty-vt parses and validates reports but keeps no records; the
//! embedder owns them (`GhosttyTerminalProgramStatusFn` contract). This module
//! implements the spec's record rules over already-validated reports:
//!
//! * a report replaces the record for its id completely;
//! * `clear` removes the id and every record beneath it (`a` clears `a/b`);
//!   an empty id clears everything (also what RIS reports);
//! * process exit and a new shell prompt drop `working`, `blocked` and
//!   `idle`; `done` and `error` survive until a later report/clear;
//! * the session also drops them once the terminal's foreground process
//!   group that made the latest report has left (see [`ProgramStatusRecords::watched_group`]);
//! * at most [`MAX_PROGRAM_STATUS_RECORDS`]; a new record over the cap evicts
//!   the record updated longest ago, except the root (`""`): it is the state
//!   consumers show, and a program's own children must not clear it.
//!
//! Text is untrusted program output. libghostty already rejects control
//! characters; records additionally drop invisible formatting characters
//! (bidi overrides/isolates, zero-width, BOM, tags) and are re-bounded to the
//! spec's byte limits before they leave the terminal.

use std::collections::BTreeMap;

use crate::protocol::{ProgramStatusKind, ProgramStatusRecord, ProgramStatusState};

/// Spec: keep at most 256 records and allow at least 64.
pub const MAX_PROGRAM_STATUS_RECORDS: usize = 256;
/// Spec byte limits (libghostty `osc/parsers/program_status.zig`).
pub const MAX_PROGRAM_STATUS_ID_BYTES: usize = 128;
pub const MAX_PROGRAM_STATUS_APP_BYTES: usize = 32;
pub const MAX_PROGRAM_STATUS_TITLE_BYTES: usize = 192;
pub const MAX_PROGRAM_STATUS_MESSAGE_BYTES: usize = 2048;
/// Upper bound on one record's text bytes; protocol size asserts build on it.
pub const MAX_PROGRAM_STATUS_RECORD_TEXT_BYTES: usize = MAX_PROGRAM_STATUS_ID_BYTES
    + MAX_PROGRAM_STATUS_APP_BYTES
    + MAX_PROGRAM_STATUS_TITLE_BYTES
    + MAX_PROGRAM_STATUS_MESSAGE_BYTES;

/// What a validated report asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramStatusAction {
    Set(ProgramStatusState),
    Clear,
}

/// One validated report, borrowed from the libghostty callback.
#[derive(Debug, Clone, Copy)]
pub struct ProgramStatusReport<'a> {
    pub action: ProgramStatusAction,
    pub kind: Option<ProgramStatusKind>,
    pub progress: Option<u8>,
    pub id: &'a [u8],
    pub app: &'a [u8],
    pub title: &'a [u8],
    pub message: &'a [u8],
}

#[derive(Debug)]
struct Entry {
    record: ProgramStatusRecord,
    /// Monotonic update stamp for LRU eviction; bumped by every report,
    /// including one that leaves the content unchanged.
    touched: u64,
}

#[derive(Debug, Default)]
pub struct ProgramStatusRecords {
    entries: BTreeMap<String, Entry>,
    clock: u64,
    /// The terminal's foreground process group when the latest report was
    /// stored; `None` when it could not be read.
    reporter_group: Option<libc::pid_t>,
}

impl ProgramStatusRecords {
    /// Apply one report. Returns true when the visible record set changed.
    pub fn apply(&mut self, report: &ProgramStatusReport<'_>, now_ms: u64) -> bool {
        let id = sanitize_text(report.id, MAX_PROGRAM_STATUS_ID_BYTES);
        let state = match report.action {
            ProgramStatusAction::Clear => return self.clear(&id),
            ProgramStatusAction::Set(state) => state,
        };
        let blocked = state == ProgramStatusState::Blocked;
        let progress_allowed = blocked || state == ProgramStatusState::Working;
        let record = ProgramStatusRecord {
            id: id.clone(),
            state,
            kind: report.kind.filter(|_| blocked),
            progress: report.progress.filter(|value| progress_allowed && *value <= 100),
            app: non_empty(sanitize_text(report.app, MAX_PROGRAM_STATUS_APP_BYTES)),
            title: non_empty(sanitize_text(report.title, MAX_PROGRAM_STATUS_TITLE_BYTES)),
            message: non_empty(sanitize_text(report.message, MAX_PROGRAM_STATUS_MESSAGE_BYTES)),
            updated_at_ms: now_ms,
        };
        self.clock += 1;
        let touched = self.clock;
        if let Some(existing) = self.entries.get_mut(&id) {
            existing.touched = touched;
            if same_content(&existing.record, &record) {
                return false;
            }
            existing.record = record;
            return true;
        }
        if self.entries.len() >= MAX_PROGRAM_STATUS_RECORDS {
            self.evict_least_recently_updated();
        }
        self.entries.insert(id, Entry { record, touched });
        true
    }

    /// Remove `id` and every record beneath it; an empty id removes all.
    pub fn clear(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        if id.is_empty() {
            self.entries.clear();
        } else {
            self.entries.retain(|key, _| !is_same_or_descendant(key, id));
        }
        self.entries.len() != before
    }

    /// Process exit / new shell prompt: drop records that describe a live
    /// program (`working`, `blocked`, `idle`); keep `done` and `error`.
    pub fn drop_transient(&mut self) -> bool {
        let before = self.entries.len();
        self.entries.retain(|_, entry| {
            matches!(entry.record.state, ProgramStatusState::Done | ProgramStatusState::Error)
        });
        self.entries.len() != before
    }

    /// Remember the foreground process group behind the latest report; each
    /// report replaces it.
    pub fn set_reporter_group(&mut self, group: Option<libc::pid_t>) {
        self.reporter_group = group;
    }

    /// The reporter group to watch: known, and some record still describes a
    /// live program (`working` or `blocked`). `None` means nothing to watch.
    pub fn watched_group(&self) -> Option<libc::pid_t> {
        let live = self.entries.values().any(|entry| {
            matches!(entry.record.state, ProgramStatusState::Working | ProgramStatusState::Blocked)
        });
        self.reporter_group.filter(|_| live)
    }

    pub fn root(&self) -> Option<&ProgramStatusRecord> {
        self.entries.get("").map(|entry| &entry.record)
    }

    /// Every record, sorted by id (the root, if any, first).
    pub fn records(&self) -> Vec<ProgramStatusRecord> {
        self.entries.values().map(|entry| entry.record.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn evict_least_recently_updated(&mut self) {
        let oldest = self
            .entries
            .iter()
            .filter(|(key, _)| !key.is_empty())
            .min_by_key(|(_, entry)| entry.touched)
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest {
            self.entries.remove(&key);
        }
    }
}

fn same_content(a: &ProgramStatusRecord, b: &ProgramStatusRecord) -> bool {
    a.state == b.state
        && a.kind == b.kind
        && a.progress == b.progress
        && a.app == b.app
        && a.title == b.title
        && a.message == b.message
}

/// `/` separates id path segments: `build` is the parent of `build/test` but
/// not of `builder`.
fn is_same_or_descendant(key: &str, ancestor: &str) -> bool {
    key == ancestor
        || (key.len() > ancestor.len()
            && key.starts_with(ancestor)
            && key.as_bytes()[ancestor.len()] == b'/')
}

fn non_empty(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

/// Invisible formatting characters that could disguise text shown outside
/// the terminal (spec security section): bidi embeddings/overrides/isolates,
/// zero-width and joiner controls, word joiner and invisible operators,
/// deprecated format controls, BOM/ZWNBSP, interlinear annotations, tags,
/// the Arabic letter mark, Mongolian vowel separator and soft hyphen.
fn is_invisible_format(ch: char) -> bool {
    matches!(
        ch,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// Decode (lossily), drop control and invisible formatting characters, and
/// cut to at most `max_bytes` on a character boundary.
pub fn sanitize_text(bytes: &[u8], max_bytes: usize) -> String {
    let mut out = String::with_capacity(bytes.len().min(max_bytes));
    for ch in String::from_utf8_lossy(bytes).chars() {
        if ch.is_control() || is_invisible_format(ch) {
            continue;
        }
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set<'a>(id: &'a str, state: ProgramStatusState) -> ProgramStatusReport<'a> {
        ProgramStatusReport {
            action: ProgramStatusAction::Set(state),
            kind: None,
            progress: None,
            id: id.as_bytes(),
            app: b"",
            title: b"",
            message: b"",
        }
    }

    fn clear(id: &str) -> ProgramStatusReport<'_> {
        ProgramStatusReport { action: ProgramStatusAction::Clear, ..set(id, ProgramStatusState::Idle) }
    }

    fn ids(records: &ProgramStatusRecords) -> Vec<String> {
        records.records().into_iter().map(|record| record.id).collect()
    }

    #[test]
    fn report_replaces_the_whole_record_for_its_id() {
        let mut records = ProgramStatusRecords::default();
        let blocked = ProgramStatusReport {
            kind: Some(ProgramStatusKind::Permission),
            progress: Some(40),
            app: b"terraform",
            title: b"Plan",
            message: b"Apply?",
            ..set("", ProgramStatusState::Blocked)
        };
        assert!(records.apply(&blocked, 10));
        let root = records.root().expect("root record");
        assert_eq!(root.state, ProgramStatusState::Blocked);
        assert_eq!(root.kind, Some(ProgramStatusKind::Permission));
        assert_eq!(root.progress, Some(40));
        assert_eq!(root.app.as_deref(), Some("terraform"));
        assert_eq!(root.title.as_deref(), Some("Plan"));
        assert_eq!(root.message.as_deref(), Some("Apply?"));
        assert_eq!(root.updated_at_ms, 10);

        // Values the new report leaves out are gone, not inherited.
        assert!(records.apply(&set("", ProgramStatusState::Done), 20));
        let root = records.root().expect("root record");
        assert_eq!(root.state, ProgramStatusState::Done);
        assert_eq!((root.kind, root.progress, root.app.as_deref(), root.message.as_deref()), (None, None, None, None));
        assert_eq!(root.updated_at_ms, 20);
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn identical_report_is_not_a_change_and_keeps_its_timestamp() {
        let mut records = ProgramStatusRecords::default();
        assert!(records.apply(&set("", ProgramStatusState::Working), 1));
        assert!(!records.apply(&set("", ProgramStatusState::Working), 2));
        assert_eq!(records.root().expect("root").updated_at_ms, 1);
    }

    #[test]
    fn kind_only_for_blocked_and_progress_only_for_working_or_blocked() {
        let mut records = ProgramStatusRecords::default();
        let done = ProgramStatusReport {
            kind: Some(ProgramStatusKind::Auth),
            progress: Some(50),
            ..set("", ProgramStatusState::Done)
        };
        records.apply(&done, 1);
        let root = records.root().expect("root");
        assert_eq!((root.kind, root.progress), (None, None));
    }

    #[test]
    fn clear_removes_the_id_and_its_descendants_only() {
        let mut records = ProgramStatusRecords::default();
        for id in ["build", "build/test", "build/test/unit", "builder", "deploy"] {
            records.apply(&set(id, ProgramStatusState::Working), 1);
        }
        assert!(records.apply(&clear("build"), 2));
        assert_eq!(ids(&records), vec!["builder", "deploy"]);
        assert!(!records.apply(&clear("missing"), 3));
        assert!(records.apply(&clear(""), 4));
        assert!(records.is_empty());
        assert!(!records.apply(&clear(""), 5));
    }

    #[test]
    fn exit_or_prompt_drops_live_states_and_keeps_done_and_error() {
        let mut records = ProgramStatusRecords::default();
        records.apply(&set("", ProgramStatusState::Blocked), 1);
        records.apply(&set("a", ProgramStatusState::Working), 1);
        records.apply(&set("b", ProgramStatusState::Idle), 1);
        records.apply(&set("c", ProgramStatusState::Done), 1);
        records.apply(&set("d", ProgramStatusState::Error), 1);
        assert!(records.drop_transient());
        assert_eq!(ids(&records), vec!["c", "d"]);
        assert!(!records.drop_transient());
    }

    #[test]
    fn cap_evicts_the_least_recently_updated_record() {
        let mut records = ProgramStatusRecords::default();
        for n in 0..MAX_PROGRAM_STATUS_RECORDS {
            records.apply(&set(&format!("r{n}"), ProgramStatusState::Working), 1);
        }
        // Re-reporting r0 (even unchanged) makes r1 the oldest update.
        assert!(!records.apply(&set("r0", ProgramStatusState::Working), 2));
        assert!(records.apply(&set("new", ProgramStatusState::Working), 3));
        assert_eq!(records.len(), MAX_PROGRAM_STATUS_RECORDS);
        let kept = ids(&records);
        assert!(kept.contains(&"r0".to_string()));
        assert!(!kept.contains(&"r1".to_string()));
        assert!(kept.contains(&"new".to_string()));
    }

    #[test]
    fn cap_never_evicts_the_root_through_its_own_children() {
        let mut records = ProgramStatusRecords::default();
        assert!(records.apply(&set("", ProgramStatusState::Working), 1));
        // Children only touch their own ids; the root stays the oldest update.
        for n in 0..300 {
            records.apply(&set(&format!("test/{n}"), ProgramStatusState::Working), 2);
        }
        assert_eq!(records.len(), MAX_PROGRAM_STATUS_RECORDS);
        assert_eq!(records.root().map(|root| root.state), Some(ProgramStatusState::Working));
        let kept = ids(&records);
        assert!(!kept.contains(&"test/0".to_string()), "oldest child was not evicted");
        assert!(kept.contains(&"test/299".to_string()));
    }

    #[test]
    fn reporter_group_is_watched_only_while_a_working_or_blocked_record_exists() {
        let mut records = ProgramStatusRecords::default();
        records.apply(&set("build", ProgramStatusState::Done), 1);
        records.set_reporter_group(Some(42));
        assert_eq!(records.watched_group(), None, "done records need no watch");
        records.apply(&set("", ProgramStatusState::Idle), 2);
        assert_eq!(records.watched_group(), None, "idle records need no watch");

        records.apply(&set("", ProgramStatusState::Working), 3);
        assert_eq!(records.watched_group(), Some(42));
        records.apply(&set("", ProgramStatusState::Blocked), 4);
        records.set_reporter_group(Some(43));
        assert_eq!(records.watched_group(), Some(43), "the latest report's group replaces the old one");

        records.set_reporter_group(None);
        assert_eq!(records.watched_group(), None, "an unreadable group is never watched");

        records.set_reporter_group(Some(43));
        assert!(records.drop_transient());
        assert_eq!(records.watched_group(), None);
        assert_eq!(ids(&records), vec!["build"]);
    }

    #[test]
    fn text_drops_bidi_and_invisible_formatting_and_is_bounded() {
        assert_eq!(sanitize_text("ok\u{202E}gnp.exe\u{200B}\u{FEFF}\u{2066}x\u{E0041}".as_bytes(), 64), "okgnp.exex");
        assert_eq!(sanitize_text(b"a\x1bb\x07c", 64), "abc");
        // Cut on a character boundary: "é" is 2 bytes.
        assert_eq!(sanitize_text("aéé".as_bytes(), 4), "aé");
        assert_eq!(sanitize_text(&[b'a', 0xff, b'b'], 64), "a\u{FFFD}b");

        let mut records = ProgramStatusRecords::default();
        let long = "m".repeat(MAX_PROGRAM_STATUS_MESSAGE_BYTES + 10);
        let spoof = ProgramStatusReport { message: long.as_bytes(), title: "\u{202E}evil".as_bytes(), ..set("", ProgramStatusState::Blocked) };
        records.apply(&spoof, 1);
        let root = records.root().expect("root");
        assert_eq!(root.message.as_ref().map(String::len), Some(MAX_PROGRAM_STATUS_MESSAGE_BYTES));
        assert_eq!(root.title.as_deref(), Some("evil"));
    }

    #[test]
    fn invisible_only_text_is_absent() {
        let mut records = ProgramStatusRecords::default();
        let report = ProgramStatusReport { message: "\u{200B}\u{202E}".as_bytes(), ..set("", ProgramStatusState::Idle) };
        records.apply(&report, 1);
        assert_eq!(records.root().expect("root").message, None);
    }
}

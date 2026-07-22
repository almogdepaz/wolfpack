use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// Session metadata
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionInfo {
    pub id: Uuid,
    pub name: String,
    pub cwd: String,
    pub command: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
    pub started_at_ms: u64,
    pub alive: bool,
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Snapshot — what the broker hands back to a fresh attach
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CellAttrs {
    pub fg: Option<u32>,
    pub bg: Option<u32>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub blink: bool,
    #[serde(default)]
    pub strike: bool,
    #[serde(default)]
    pub dim: bool,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StyledCell {
    pub ch: String,
    #[serde(default)]
    pub attrs: CellAttrs,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StyledLine {
    #[serde(default)]
    pub cells: Vec<StyledCell>,
    #[serde(default)]
    pub wrapped: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CursorShape {
    Block,
    Underline,
    Bar,
}

impl Default for CursorShape {
    fn default() -> Self {
        CursorShape::Block
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CursorState {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
    #[serde(default)]
    pub shape: CursorShape,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MouseMode {
    Off,
    X10,
    Vt200,
    ButtonEvent,
    AnyEvent,
    Sgr,
}

impl Default for MouseMode {
    fn default() -> Self {
        MouseMode::Off
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalModes {
    #[serde(default)]
    pub alt_screen: bool,
    #[serde(default)]
    pub application_cursor: bool,
    #[serde(default)]
    pub application_keypad: bool,
    #[serde(default)]
    pub bracketed_paste: bool,
    #[serde(default)]
    pub mouse_mode: MouseMode,
    #[serde(default)]
    pub origin_mode: bool,
    #[serde(default = "default_true")]
    pub auto_wrap: bool,
    #[serde(default)]
    pub insert_mode: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScrollRegion {
    pub top: u16,
    pub bottom: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub session_id: Uuid,
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub visible_screen: Vec<StyledLine>,
    #[serde(default)]
    pub scrollback: Vec<StyledLine>,
    pub cursor: CursorState,
    #[serde(default)]
    pub modes: TerminalModes,
    pub scroll_region: ScrollRegion,
    #[serde(default)]
    pub title: Option<String>,
    pub captured_at_ms: u64,
}

// ---------------------------------------------------------------------------
// Control plane envelopes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ControlRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl ControlRequest {
    pub fn parse_params<T: serde::de::DeserializeOwned>(&self) -> serde_json::Result<T> {
        serde_json::from_value(self.params.clone())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ControlResponse {
    pub id: u64,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<ResponsePayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

impl ControlResponse {
    pub fn ok(id: u64, payload: ResponsePayload) -> Self {
        Self { id, status: Status::Ok, payload: Some(payload), error: None }
    }

    pub fn err(id: u64, error: ProtocolError) -> Self {
        Self { id, status: Status::Error, payload: None, error: Some(error) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResponsePayload {
    ListSessions { sessions: Vec<SessionInfo> },
    CreateSession { session: SessionInfo },
    KillSession { killed: bool },
    SessionInfo { session: SessionInfo },
    Snapshot { snapshot: Snapshot },
    Resize { ok: bool },
    Subscribe { ok: bool, current_seq: u64, replay_truncated: bool },
    Unsubscribe { ok: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    UnknownMethod,
    UnknownSession,
    DuplicateSessionName,
    SessionNotAlive,
    SpawnFailed,
    ResizeFailed,
    InternalError,
    Unsupported,
}

// ---------------------------------------------------------------------------
// Method names + typed parameter structs
// ---------------------------------------------------------------------------

pub mod methods {
    pub const LIST_SESSIONS: &str = "list_sessions";
    pub const CREATE_SESSION: &str = "create_session";
    pub const KILL_SESSION: &str = "kill_session";
    pub const SESSION_INFO: &str = "session_info";
    pub const SNAPSHOT: &str = "snapshot";
    pub const RESIZE: &str = "resize";
    pub const SUBSCRIBE: &str = "subscribe";
    pub const UNSUBSCRIBE: &str = "unsubscribe";
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListSessionsParams {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateSessionParams {
    #[serde(default)]
    pub name: Option<String>,
    pub cwd: String,
    pub command: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KillSessionParams {
    pub session_id: Uuid,
    #[serde(default)]
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionInfoParams {
    pub session_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotParams {
    pub session_id: Uuid,
    #[serde(default)]
    pub scrollback_lines: Option<u32>,
    /// When present, reflow scrollback to this column width before returning.
    /// Omitting the field skips reflow (back-compat: old callers get raw rows).
    #[serde(default)]
    pub target_cols: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResizeParams {
    pub session_id: Uuid,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscribeParams {
    pub session_id: Uuid,
    #[serde(default)]
    pub since_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnsubscribeParams {
    pub session_id: Uuid,
}

// ---------------------------------------------------------------------------
// Async events (broker → client, not tied to a request id)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    SessionStarted { session: SessionInfo },
    SessionExited {
        session_id: Uuid,
        #[serde(default)]
        exit_code: Option<i32>,
        #[serde(default)]
        signal: Option<i32>,
    },
    SessionResized { session_id: Uuid, cols: u16, rows: u16 },
    SnapshotInvalidated { session_id: Uuid },
    /// Emitted directly to the connection that had its subscription dropped
    /// due to broadcast lag. The client should re-subscribe from its last
    /// delivered seq. This event is NOT broadcast to all clients: it is queued
    /// on the affected connection's output stream after all accepted frames,
    /// making it an ordering barrier for safe replay recovery.
    SubscriptionDropped { session_id: Uuid, lagged: u64 },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn nil() -> Uuid {
        Uuid::nil()
    }

    fn sample_session() -> SessionInfo {
        SessionInfo {
            id: nil(),
            name: "ralph".into(),
            cwd: "/tmp".into(),
            command: vec!["bash".into(), "-l".into()],
            env: vec![("FOO".into(), "bar".into())],
            cols: 120,
            rows: 30,
            pid: Some(123),
            started_at_ms: 1_700_000_000_000,
            alive: true,
            exit_code: None,
        }
    }

    fn sample_snapshot() -> Snapshot {
        Snapshot {
            session_id: nil(),
            seq: 42,
            cols: 80,
            rows: 24,
            visible_screen: vec![StyledLine {
                cells: vec![StyledCell { ch: "h".into(), attrs: CellAttrs::default() }],
                wrapped: false,
            }],
            scrollback: vec![],
            cursor: CursorState { row: 0, col: 1, visible: true, shape: CursorShape::Block },
            modes: TerminalModes::default(),
            scroll_region: ScrollRegion { top: 0, bottom: 23 },
            title: Some("ralph".into()),
            captured_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn request_envelope_roundtrip() {
        let req = ControlRequest {
            id: 1,
            method: methods::LIST_SESSIONS.into(),
            params: json!({}),
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: ControlRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(req, back);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["method"], "list_sessions");
    }

    #[test]
    fn create_session_params_roundtrip() {
        let p = CreateSessionParams {
            name: Some("ralph".into()),
            cwd: "/tmp".into(),
            command: vec!["bash".into(), "-l".into()],
            env: vec![("FOO".into(), "bar".into())],
            cols: 120,
            rows: 30,
        };
        let req = ControlRequest {
            id: 7,
            method: methods::CREATE_SESSION.into(),
            params: serde_json::to_value(&p).unwrap(),
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: ControlRequest = serde_json::from_str(&s).unwrap();
        let parsed: CreateSessionParams = back.parse_params().unwrap();
        assert_eq!(parsed, p);
    }

    #[test]
    fn kill_session_params_roundtrip() {
        let p = KillSessionParams { session_id: nil(), signal: Some(15) };
        let v = serde_json::to_value(&p).unwrap();
        let back: KillSessionParams = serde_json::from_value(v).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn snapshot_params_optional_scrollback_lines() {
        let v = json!({ "session_id": Uuid::nil() });
        let p: SnapshotParams = serde_json::from_value(v).unwrap();
        assert_eq!(p.session_id, nil());
        assert!(p.scrollback_lines.is_none());
        assert!(p.target_cols.is_none());
    }

    #[test]
    fn snapshot_params_target_cols_roundtrip() {
        let v = json!({ "session_id": Uuid::nil(), "scrollback_lines": 500, "target_cols": 80 });
        let p: SnapshotParams = serde_json::from_value(v).unwrap();
        assert_eq!(p.scrollback_lines, Some(500));
        assert_eq!(p.target_cols, Some(80));
        // Serialise and round-trip.
        let back: SnapshotParams = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back.target_cols, Some(80));
    }

    #[test]
    fn snapshot_params_old_client_omits_target_cols() {
        // Old callers that don't send `target_cols` must deserialize to None (no reflow).
        let v = json!({ "session_id": Uuid::nil(), "scrollback_lines": 200 });
        let p: SnapshotParams = serde_json::from_value(v).unwrap();
        assert!(p.target_cols.is_none());
    }

    #[test]
    fn response_ok_payload_kind_tag() {
        let resp = ControlResponse::ok(
            7,
            ResponsePayload::SessionInfo { session: sample_session() },
        );
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["payload"]["kind"], "session_info");
        assert!(v.get("error").is_none() || v["error"].is_null());
        let back: ControlResponse = serde_json::from_value(v).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn response_list_sessions_payload() {
        let resp = ControlResponse::ok(
            5,
            ResponsePayload::ListSessions { sessions: vec![sample_session()] },
        );
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["payload"]["kind"], "list_sessions");
        let back: ControlResponse = serde_json::from_value(v).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn response_subscribe_payload() {
        let resp = ControlResponse::ok(
            12,
            ResponsePayload::Subscribe { ok: true, current_seq: 99, replay_truncated: false },
        );
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["payload"]["kind"], "subscribe");
        assert_eq!(v["payload"]["current_seq"], 99);
        let back: ControlResponse = serde_json::from_value(v).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn response_error_shape() {
        let resp = ControlResponse::err(
            9,
            ProtocolError {
                code: ErrorCode::UnknownSession,
                message: "no such id".into(),
            },
        );
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["status"], "error");
        assert_eq!(v["error"]["code"], "unknown_session");
        let back: ControlResponse = serde_json::from_value(v).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn snapshot_roundtrip() {
        let snap = sample_snapshot();
        let s = serde_json::to_string(&snap).unwrap();
        let back: Snapshot = serde_json::from_str(&s).unwrap();
        assert_eq!(snap, back);
    }

    #[test]
    fn snapshot_payload_envelope() {
        let resp = ControlResponse::ok(
            3,
            ResponsePayload::Snapshot { snapshot: sample_snapshot() },
        );
        let s = serde_json::to_string(&resp).unwrap();
        let back: ControlResponse = serde_json::from_str(&s).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn event_session_exited_roundtrip() {
        let ev = Event::SessionExited {
            session_id: nil(),
            exit_code: Some(0),
            signal: None,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["event"], "session_exited");
        let back: Event = serde_json::from_value(v).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn event_session_resized_roundtrip() {
        let ev = Event::SessionResized { session_id: nil(), cols: 100, rows: 40 };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["event"], "session_resized");
        let back: Event = serde_json::from_value(v).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn protocol_version_is_two() {
        assert_eq!(PROTOCOL_VERSION, 2);
    }

    #[test]
    fn styled_line_wrapped_roundtrip() {
        let line = StyledLine {
            cells: vec![StyledCell { ch: "x".into(), attrs: CellAttrs::default() }],
            wrapped: true,
        };
        let v = serde_json::to_value(&line).unwrap();
        assert_eq!(v["wrapped"], true);
        let back: StyledLine = serde_json::from_value(v).unwrap();
        assert_eq!(back.wrapped, true);
    }

    #[test]
    fn styled_line_wrapped_defaults_false() {
        // Old clients that omit `wrapped` must deserialize to false.
        let v = serde_json::json!({ "cells": [] });
        let line: StyledLine = serde_json::from_value(v).unwrap();
        assert!(!line.wrapped);
    }
}

//! Session-aware router.
//!
//! Wires a shared `Registry` into the broker's `Router` trait so that the
//! control plane can drive session lifecycle. `subscribe` and `unsubscribe`
//! are intercepted by the server connection handler before they reach the
//! router (they need per-connection writer state the router can't see); if
//! a `subscribe`/`unsubscribe` request ever leaks through to here it is
//! reported as `internal_error` so a routing regression can't silently
//! drop live-output streams. `snapshot` is served from the per-session
//! terminal-state emulator and `resize` reaches the PTY master directly,
//! then broadcasts both `session_resized` and `snapshot_invalidated` so
//! any observer attached to the bus can re-flow and re-snapshot in
//! lockstep with the new dimensions.
//!
//! Lifecycle events fired here travel over the same `EventSender` shared
//! by the registry (`session_started`) and the per-session reaper
//! (`session_exited`); per-connection forwarders in
//! [`crate::server::handle_connection`] subscribe and emit `Frame::Event`
//! to clients.
//!
//! Error mapping (registry/session → protocol code):
//!   * `CreateError::DuplicateName`      → `duplicate_session_name`
//!   * `CreateError::Spawn(_)`           → `spawn_failed`
//!   * missing session id                → `unknown_session`
//!   * `KillOutcome::NotAlive`           → `session_not_alive`
//!   * `ResizeError::Pty(_)`             → `resize_failed`
//!   * malformed params                  → `invalid_request`

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::broadcast;
use uuid::Uuid;

use crate::protocol::{
    methods, ControlRequest, ControlResponse, CreateSessionParams, ErrorCode, Event,
    KillSessionParams, ListSessionsParams, ProtocolError, ResizeParams, ResponsePayload,
    SessionInfoParams, SnapshotParams,
};
use crate::registry::{CreateError, CreateOptions, Registry};
use crate::router::Router;
use crate::session::{EventSender, KillError, KillOutcome, ResizeError, SpawnError};
use crate::terminal_state::TerminalStateError;

pub const EVENT_BUS_CAPACITY: usize = 256;
const MIN_TERMINAL_COLS: u16 = 20;
const MAX_TERMINAL_COLS: u16 = 300;
const MIN_TERMINAL_ROWS: u16 = 5;
const MAX_TERMINAL_ROWS: u16 = 100;
const MAX_CONCURRENT_SNAPSHOTS: usize = 4;

struct SnapshotSlot<'a>(&'a AtomicUsize);

impl Drop for SnapshotSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

pub struct SessionRouter {
    registry: Arc<Registry>,
    events: EventSender,
    snapshots_in_flight: AtomicUsize,
}

impl SessionRouter {
    pub fn new(registry: Arc<Registry>, events: EventSender) -> Self {
        Self {
            registry,
            events,
            snapshots_in_flight: AtomicUsize::new(0),
        }
    }

    /// Subscribe to broker-emitted async events. Used by per-connection
    /// forwarders to fan events out to clients, and by tests.
    pub fn subscribe_events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }
}

impl Router for SessionRouter {
    fn handle(&self, req: ControlRequest) -> ControlResponse {
        let id = req.id;
        match req.method.as_str() {
            methods::LIST_SESSIONS => match req.parse_params::<ListSessionsParams>() {
                Ok(_) => self.list(id),
                Err(e) => invalid_request(id, format!("list_sessions params: {e}")),
            },
            methods::CREATE_SESSION => match req.parse_params::<CreateSessionParams>() {
                Ok(p) => self.create(id, p),
                Err(e) => invalid_request(id, format!("create_session params: {e}")),
            },
            methods::KILL_SESSION => match req.parse_params::<KillSessionParams>() {
                Ok(p) => self.kill(id, p),
                Err(e) => invalid_request(id, format!("kill_session params: {e}")),
            },
            methods::SESSION_INFO => match req.parse_params::<SessionInfoParams>() {
                Ok(p) => self.session_info(id, p),
                Err(e) => invalid_request(id, format!("session_info params: {e}")),
            },
            methods::SNAPSHOT => match req.parse_params::<SnapshotParams>() {
                Ok(p) => self.snapshot(id, p),
                Err(e) => invalid_request(id, format!("snapshot params: {e}")),
            },
            methods::RESIZE => match req.parse_params::<ResizeParams>() {
                Ok(p) => self.resize(id, p),
                Err(e) => invalid_request(id, format!("resize params: {e}")),
            },
            methods::SUBSCRIBE | methods::UNSUBSCRIBE => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::InternalError,
                    message: format!(
                        "method {} must be handled by the connection layer, not routed here",
                        req.method
                    ),
                },
            ),
            other => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::UnknownMethod,
                    message: format!("unknown method: {other}"),
                },
            ),
        }
    }
}

impl SessionRouter {
    fn list(&self, id: u64) -> ControlResponse {
        let sessions = self
            .registry
            .list()
            .iter()
            .map(|s| s.info())
            .collect();
        ControlResponse::ok(id, ResponsePayload::ListSessions { sessions })
    }

    fn create(&self, id: u64, p: CreateSessionParams) -> ControlResponse {
        if let Err(message) = validate_dimensions(p.cols, p.rows) {
            return invalid_request(id, format!("create_session params: {message}"));
        }
        let opts = CreateOptions {
            name: p.name,
            cwd: p.cwd,
            command: p.command,
            env: p.env,
            cols: p.cols,
            rows: p.rows,
        };
        match self.registry.create(opts) {
            Ok(sess) => ControlResponse::ok(
                id,
                ResponsePayload::CreateSession {
                    session: sess.info(),
                },
            ),
            Err(CreateError::DuplicateName(name)) => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::DuplicateSessionName,
                    message: format!("session name {name:?} already in use"),
                },
            ),
            Err(CreateError::Spawn(SpawnError::Terminal(error))) => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::InternalError,
                    message: format!("terminal state failed: {error}"),
                },
            ),
            Err(CreateError::Spawn(spawn)) => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::SpawnFailed,
                    message: format!("spawn failed: {spawn}"),
                },
            ),
        }
    }

    fn kill(&self, id: u64, p: KillSessionParams) -> ControlResponse {
        let sess = match self.registry.get(p.session_id) {
            Some(s) => s,
            None => return unknown_session(id, p.session_id),
        };
        let signal = p.signal.unwrap_or(libc::SIGTERM);
        match sess.kill(signal) {
            Ok(KillOutcome::Killed) => {
                ControlResponse::ok(id, ResponsePayload::KillSession { killed: true })
            }
            Ok(KillOutcome::NotAlive) => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::SessionNotAlive,
                    message: format!("session {} is not alive", p.session_id),
                },
            ),
            Err(KillError::NoPid) => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::InternalError,
                    message: format!("session {} has no recorded pid", p.session_id),
                },
            ),
            Err(KillError::Errno(e)) => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::InternalError,
                    message: format!("kill syscall failed: errno {e}"),
                },
            ),
        }
    }

    fn session_info(&self, id: u64, p: SessionInfoParams) -> ControlResponse {
        match self.registry.get(p.session_id) {
            Some(s) => ControlResponse::ok(
                id,
                ResponsePayload::SessionInfo {
                    session: s.info(),
                },
            ),
            None => unknown_session(id, p.session_id),
        }
    }

    fn snapshot(&self, id: u64, p: SnapshotParams) -> ControlResponse {
        if let Err(message) = validate_snapshot_target_cols(p.target_cols) {
            return invalid_request(id, format!("snapshot params: {message}"));
        }
        let previous = self.snapshots_in_flight.fetch_add(1, Ordering::Acquire);
        if previous >= MAX_CONCURRENT_SNAPSHOTS {
            self.snapshots_in_flight.fetch_sub(1, Ordering::Release);
            return ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::InternalError,
                    message: "snapshot concurrency limit reached; retry".into(),
                },
            );
        }
        let _slot = SnapshotSlot(&self.snapshots_in_flight);
        match self.registry.get(p.session_id) {
            Some(s) => match s.snapshot_terminal(p.scrollback_lines, p.target_cols) {
                Ok(snapshot) => ControlResponse::ok(id, ResponsePayload::Snapshot { snapshot }),
                Err(error) => terminal_snapshot_error(id, error),
            },
            None => unknown_session(id, p.session_id),
        }
    }

    fn resize(&self, id: u64, p: ResizeParams) -> ControlResponse {
        if let Err(message) = validate_dimensions(p.cols, p.rows) {
            return invalid_request(id, format!("resize params: {message}"));
        }
        let sess = match self.registry.get(p.session_id) {
            Some(s) => s,
            None => return unknown_session(id, p.session_id),
        };
        match sess.resize(p.cols, p.rows, &self.events) {
            Ok(()) => {
                // session_resized + snapshot_invalidated are now fired inside
                // Session::resize so the invariant lives with the type that
                // owns the PTY state. Nothing else to do here.
                ControlResponse::ok(id, ResponsePayload::Resize { ok: true })
            }
            Err(ResizeError::Pty(msg)) => resize_failed(id, format!("resize failed: {msg}")),
            Err(error @ ResizeError::PtyWithTerminalRollback { .. }) => {
                resize_failed(id, format!("resize failed: {error}"))
            }
            Err(ResizeError::Terminal(error)) => ControlResponse::err(
                id,
                ProtocolError {
                    code: ErrorCode::InternalError,
                    message: format!("terminal resize failed: {error}"),
                },
            ),
        }
    }
}

fn validate_snapshot_target_cols(target_cols: Option<u16>) -> Result<(), String> {
    if let Some(cols) = target_cols {
        if cols > MAX_TERMINAL_COLS {
            return Err(format!("target_cols must be at most {MAX_TERMINAL_COLS}"));
        }
    }
    Ok(())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), String> {
    if !(MIN_TERMINAL_COLS..=MAX_TERMINAL_COLS).contains(&cols) {
        return Err(format!(
            "cols must be between {MIN_TERMINAL_COLS} and {MAX_TERMINAL_COLS}"
        ));
    }
    if !(MIN_TERMINAL_ROWS..=MAX_TERMINAL_ROWS).contains(&rows) {
        return Err(format!(
            "rows must be between {MIN_TERMINAL_ROWS} and {MAX_TERMINAL_ROWS}"
        ));
    }
    Ok(())
}

fn resize_failed(id: u64, message: String) -> ControlResponse {
    ControlResponse::err(
        id,
        ProtocolError {
            code: ErrorCode::ResizeFailed,
            message,
        },
    )
}

fn terminal_snapshot_error(id: u64, error: TerminalStateError) -> ControlResponse {
    ControlResponse::err(
        id,
        ProtocolError {
            code: ErrorCode::InternalError,
            message: format!("terminal snapshot failed: {error}"),
        },
    )
}

fn invalid_request(id: u64, msg: impl Into<String>) -> ControlResponse {
    ControlResponse::err(
        id,
        ProtocolError {
            code: ErrorCode::InvalidRequest,
            message: msg.into(),
        },
    )
}

fn unknown_session(id: u64, sid: Uuid) -> ControlResponse {
    ControlResponse::err(
        id,
        ProtocolError {
            code: ErrorCode::UnknownSession,
            message: format!("unknown session: {sid}"),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Status;
    use serde_json::json;
    use std::time::Duration;

    fn req(id: u64, method: &str, params: serde_json::Value) -> ControlRequest {
        ControlRequest {
            id,
            method: method.into(),
            params,
        }
    }

    fn router() -> (SessionRouter, Arc<Registry>) {
        let (events, _rx) = broadcast::channel::<Event>(EVENT_BUS_CAPACITY);
        let reg = Arc::new(Registry::new(events.clone()));
        (SessionRouter::new(Arc::clone(&reg), events), reg)
    }

    fn create_params(name: Option<&str>, cmd: &[&str]) -> serde_json::Value {
        json!({
            "name": name,
            "cwd": "/tmp",
            "command": cmd,
            "cols": 80,
            "rows": 24,
        })
    }

    fn oversized_combining_sequence() -> String {
        let mut input = String::from("a");
        for _ in 0..1100 {
            input.push('\u{0301}');
        }
        input
    }

    fn cleanup(reg: &Registry) {
        for s in reg.list() {
            let _ = s.kill(libc::SIGKILL);
            let _ = s.wait_for_exit(Duration::from_secs(5));
        }
    }

    #[test]
    fn subscribe_unsubscribe_routed_through_router_report_internal_error() {
        // The connection layer intercepts these methods before they reach
        // the router; if a routing regression ever lets them through here,
        // the response surfaces a clear internal_error instead of silently
        // pretending to attach a stream.
        let (router, _reg) = router();
        for method in [methods::SUBSCRIBE, methods::UNSUBSCRIBE] {
            let resp = router.handle(req(1, method, json!({ "session_id": Uuid::nil() })));
            assert_eq!(resp.status, Status::Error, "{method}");
            assert_eq!(
                resp.error.as_ref().unwrap().code,
                ErrorCode::InternalError,
                "{method}"
            );
        }
    }

    #[test]
    fn create_rejects_out_of_contract_dimensions_and_accepts_boundaries() {
        let (router, reg) = router();
        for (cols, rows) in [(0, 24), (80, 0), (19, 24), (301, 24), (80, 4), (80, 101)] {
            let mut params = create_params(Some("invalid-size"), &["sleep", "30"]);
            params["cols"] = json!(cols);
            params["rows"] = json!(rows);
            let response = router.handle(req(1, methods::CREATE_SESSION, params));
            assert_eq!(response.status, Status::Error, "{cols}x{rows}");
            assert_eq!(
                response.error.expect("error").code,
                ErrorCode::InvalidRequest,
                "{cols}x{rows}"
            );
        }

        for (id, name, cols, rows) in [(2, "minimum-size", 20, 5), (3, "maximum-size", 300, 100)] {
            let mut params = create_params(Some(name), &["sleep", "30"]);
            params["cols"] = json!(cols);
            params["rows"] = json!(rows);
            let response = router.handle(req(id, methods::CREATE_SESSION, params));
            assert_eq!(response.status, Status::Ok, "{cols}x{rows}");
        }
        cleanup(&reg);
    }

    #[test]
    fn resize_rejects_out_of_contract_dimensions_without_mutating_session() {
        let (router, reg) = router();
        let create = router.handle(req(
            1,
            methods::CREATE_SESSION,
            create_params(Some("resize-validation"), &["sleep", "30"]),
        ));
        let session = match create.payload.expect("payload") {
            ResponsePayload::CreateSession { session } => session,
            other => panic!("unexpected: {other:?}"),
        };

        for (cols, rows) in [(0, 24), (80, 0), (19, 24), (301, 24), (80, 4), (80, 101)] {
            let response = router.handle(req(
                2,
                methods::RESIZE,
                json!({ "session_id": session.id, "cols": cols, "rows": rows }),
            ));
            assert_eq!(response.status, Status::Error, "{cols}x{rows}");
            assert_eq!(
                response.error.expect("error").code,
                ErrorCode::InvalidRequest,
                "{cols}x{rows}"
            );
            let state = reg.get(session.id).expect("session").snapshot();
            assert_eq!((state.cols, state.rows), (80, 24), "{cols}x{rows}");
        }

        for (cols, rows) in [(20, 5), (300, 100)] {
            let response = router.handle(req(
                3,
                methods::RESIZE,
                json!({ "session_id": session.id, "cols": cols, "rows": rows }),
            ));
            assert_eq!(response.status, Status::Ok, "{cols}x{rows}");
            let state = reg.get(session.id).expect("session").snapshot();
            assert_eq!((state.cols, state.rows), (cols, rows));
        }
        cleanup(&reg);
    }

    #[test]
    fn terminal_snapshot_processing_failure_maps_to_internal_error() {
        let response = terminal_snapshot_error(
            44,
            TerminalStateError::GhosttyVtProcessing {
                operation: "snapshot",
            },
        );

        assert_eq!(response.status, Status::Error);
        let error = response.error.expect("error");
        assert_eq!(error.code, ErrorCode::InternalError);
        assert!(error.message.contains("terminal snapshot failed"));
        assert!(error.message.contains("ghostty-vt"));
    }

    #[test]
    fn resize_unknown_session_returns_unknown_session() {
        let (router, _reg) = router();
        let resp = router.handle(req(
            1,
            methods::RESIZE,
            json!({ "session_id": Uuid::nil(), "cols": 100, "rows": 40 }),
        ));
        assert_eq!(resp.status, Status::Error);
        assert_eq!(resp.error.unwrap().code, ErrorCode::UnknownSession);
    }

    #[test]
    fn resize_invalid_params_returns_invalid_request() {
        let (router, _reg) = router();
        let resp = router.handle(req(
            1,
            methods::RESIZE,
            json!({ "session_id": "not-a-uuid", "cols": 100, "rows": 40 }),
        ));
        assert_eq!(resp.status, Status::Error);
        assert_eq!(resp.error.unwrap().code, ErrorCode::InvalidRequest);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resize_known_session_updates_dimensions_and_emits_event() {
        let (router, reg) = router();
        let mut events = router.subscribe_events();

        let create = router.handle(req(
            1,
            methods::CREATE_SESSION,
            create_params(Some("resize-target"), &["sleep", "30"]),
        ));
        let session = match create.payload.expect("payload") {
            ResponsePayload::CreateSession { session } => session,
            other => panic!("unexpected: {other:?}"),
        };
        assert_eq!((session.cols, session.rows), (80, 24));

        let resp = router.handle(req(
            2,
            methods::RESIZE,
            json!({ "session_id": session.id, "cols": 132, "rows": 50 }),
        ));
        assert_eq!(resp.status, Status::Ok);
        match resp.payload.expect("payload") {
            ResponsePayload::Resize { ok } => assert!(ok),
            other => panic!("unexpected: {other:?}"),
        }

        // resize publishes SessionResized THEN SnapshotInvalidated, in
        // that order, so we must observe both in sequence.
        let mut got_resized = false;
        let mut got_invalidated = false;
        for _ in 0..6 {
            let ev = tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("event timeout")
                .expect("event recv");
            match ev {
                Event::SessionResized {
                    session_id,
                    cols,
                    rows,
                } => {
                    assert_eq!(session_id, session.id);
                    assert_eq!((cols, rows), (132, 50));
                    got_resized = true;
                }
                Event::SnapshotInvalidated { session_id } => {
                    assert_eq!(session_id, session.id);
                    got_invalidated = true;
                }
                Event::SessionStarted { .. } => {
                    // From the create call earlier — accept and continue.
                }
                other => panic!("unexpected event: {other:?}"),
            }
            if got_resized && got_invalidated {
                break;
            }
        }
        assert!(got_resized, "missing SessionResized event");
        assert!(got_invalidated, "missing SnapshotInvalidated event");

        // session_info reflects new dims (SessionState path).
        let info = router.handle(req(
            3,
            methods::SESSION_INFO,
            json!({ "session_id": session.id }),
        ));
        match info.payload.expect("payload") {
            ResponsePayload::SessionInfo { session: s } => {
                assert_eq!((s.cols, s.rows), (132, 50));
            }
            other => panic!("unexpected: {other:?}"),
        }

        // snapshot reflects new dims (TerminalState path).
        let snap = router.handle(req(
            4,
            methods::SNAPSHOT,
            json!({ "session_id": session.id }),
        ));
        match snap.payload.expect("payload") {
            ResponsePayload::Snapshot { snapshot } => {
                assert_eq!((snapshot.cols, snapshot.rows), (132, 50));
                assert_eq!(snapshot.visible_screen.len(), 50);
            }
            other => panic!("unexpected: {other:?}"),
        }

        cleanup(&reg);
    }

    #[test]
    fn authoritative_oversized_grapheme_snapshot_router_returns_internal_error_without_panic() {
        let (router, reg) = router();
        let create = router.handle(req(
            1,
            methods::CREATE_SESSION,
            json!({
                "name": "ffi-router-limit",
                "cwd": "/tmp",
                "command": ["/usr/bin/printf", oversized_combining_sequence()],
                "cols": 80,
                "rows": 24,
            }),
        ));
        assert_eq!(create.status, Status::Ok);
        let session = match create.payload.expect("payload") {
            ResponsePayload::CreateSession { session } => session,
            other => panic!("unexpected: {other:?}"),
        };
        let owned_session = reg.get(session.id).expect("broker-owned session");
        assert!(
            owned_session
                .output_bus()
                .wait_closed(Duration::from_secs(5)),
            "session output must drain before snapshot"
        );
        assert!(
            owned_session.wait_for_exit(Duration::from_secs(5)),
            "printf process should exit without broker panic"
        );

        let snapshot = router.handle(req(
            2,
            methods::SNAPSHOT,
            json!({ "session_id": session.id }),
        ));
        assert_eq!(snapshot.status, Status::Error);
        let error = snapshot.error.expect("snapshot error");
        assert_eq!(error.code, ErrorCode::InternalError);
        assert!(
            error.message.contains("terminal snapshot failed"),
            "unexpected error message: {}",
            error.message
        );

        let list = router.handle(req(3, methods::LIST_SESSIONS, json!({})));
        assert_eq!(list.status, Status::Ok, "router remains usable after error");
        cleanup(&reg);
    }

    #[test]
    fn snapshot_target_cols_above_terminal_ceiling_is_invalid_before_session_lookup() {
        let (router, reg) = router();
        let create = router.handle(req(
            1,
            methods::CREATE_SESSION,
            create_params(Some("target-cols-bound"), &["sleep", "30"]),
        ));
        let session = match create.payload.expect("payload") {
            ResponsePayload::CreateSession { session } => session,
            other => panic!("unexpected: {other:?}"),
        };

        for target_cols in [4, 300] {
            let response = router.handle(req(
                2,
                methods::SNAPSHOT,
                json!({ "session_id": session.id, "target_cols": target_cols }),
            ));
            assert_eq!(response.status, Status::Ok, "target_cols={target_cols}");
        }

        for target_cols in [301, 65535] {
            let response = router.handle(req(
                3,
                methods::SNAPSHOT,
                json!({ "session_id": session.id, "target_cols": target_cols }),
            ));
            assert_eq!(response.status, Status::Error, "target_cols={target_cols}");
            assert_eq!(
                response.error.expect("error").code,
                ErrorCode::InvalidRequest,
                "target_cols={target_cols}"
            );
        }

        let invalid_unknown = router.handle(req(
            4,
            methods::SNAPSHOT,
            json!({ "session_id": Uuid::nil(), "target_cols": 301 }),
        ));
        assert_eq!(invalid_unknown.status, Status::Error);
        assert_eq!(
            invalid_unknown.error.expect("error").code,
            ErrorCode::InvalidRequest,
            "invalid target_cols must be rejected before session lookup"
        );

        let still_usable = router.handle(req(
            5,
            methods::SNAPSHOT,
            json!({ "session_id": session.id, "target_cols": 300 }),
        ));
        assert_eq!(still_usable.status, Status::Ok);
        cleanup(&reg);
    }

    #[test]
    fn snapshot_unknown_session_returns_unknown_session() {
        let (router, _reg) = router();
        let resp = router.handle(req(
            1,
            methods::SNAPSHOT,
            json!({ "session_id": Uuid::nil() }),
        ));
        assert_eq!(resp.status, Status::Error);
        assert_eq!(resp.error.unwrap().code, ErrorCode::UnknownSession);
    }

    #[test]
    fn snapshot_known_session_returns_snapshot_payload() {
        let (router, reg) = router();
        let create = router.handle(req(
            1,
            methods::CREATE_SESSION,
            create_params(Some("snap-target"), &["sleep", "30"]),
        ));
        let session = match create.payload.expect("payload") {
            ResponsePayload::CreateSession { session } => session,
            other => panic!("unexpected: {other:?}"),
        };

        let resp = router.handle(req(
            2,
            methods::SNAPSHOT,
            json!({ "session_id": session.id }),
        ));
        assert_eq!(resp.status, Status::Ok);
        match resp.payload.expect("payload") {
            ResponsePayload::Snapshot { snapshot } => {
                assert_eq!(snapshot.session_id, session.id);
                assert_eq!(snapshot.cols, 80);
                assert_eq!(snapshot.rows, 24);
                assert_eq!(snapshot.visible_screen.len(), 24);
            }
            other => panic!("unexpected: {other:?}"),
        }
        cleanup(&reg);
    }

    #[test]
    fn snapshot_invalid_params_returns_invalid_request() {
        let (router, _reg) = router();
        let resp = router.handle(req(
            1,
            methods::SNAPSHOT,
            json!({ "session_id": "not-a-uuid" }),
        ));
        assert_eq!(resp.status, Status::Error);
        assert_eq!(resp.error.unwrap().code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn unknown_method_yields_unknown_method_error() {
        let (router, _reg) = router();
        let resp = router.handle(req(11, "do_a_barrel_roll", json!({})));
        assert_eq!(resp.error.unwrap().code, ErrorCode::UnknownMethod);
    }

    #[test]
    fn list_then_create_then_list_round_trip() {
        let (router, reg) = router();

        let resp = router.handle(req(1, methods::LIST_SESSIONS, json!({})));
        match resp.payload.expect("payload") {
            ResponsePayload::ListSessions { sessions } => assert!(sessions.is_empty()),
            other => panic!("unexpected: {other:?}"),
        }

        let resp = router.handle(req(
            2,
            methods::CREATE_SESSION,
            create_params(Some("alpha"), &["sleep", "30"]),
        ));
        assert_eq!(resp.status, Status::Ok);
        let created = match resp.payload.expect("payload") {
            ResponsePayload::CreateSession { session } => session,
            other => panic!("unexpected: {other:?}"),
        };
        assert_eq!(created.name, "alpha");

        let resp = router.handle(req(3, methods::LIST_SESSIONS, json!({})));
        match resp.payload.expect("payload") {
            ResponsePayload::ListSessions { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].id, created.id);
            }
            other => panic!("unexpected: {other:?}"),
        }

        cleanup(&reg);
    }

    #[test]
    fn duplicate_name_maps_to_duplicate_session_name() {
        let (router, reg) = router();
        let _ = router.handle(req(
            1,
            methods::CREATE_SESSION,
            create_params(Some("ralph"), &["sleep", "30"]),
        ));
        let resp = router.handle(req(
            2,
            methods::CREATE_SESSION,
            create_params(Some("ralph"), &["sleep", "30"]),
        ));
        assert_eq!(resp.status, Status::Error);
        assert_eq!(resp.error.unwrap().code, ErrorCode::DuplicateSessionName);
        cleanup(&reg);
    }

    #[test]
    fn session_info_unknown_id_returns_unknown_session() {
        let (router, _reg) = router();
        let resp = router.handle(req(
            1,
            methods::SESSION_INFO,
            json!({ "session_id": Uuid::nil() }),
        ));
        assert_eq!(resp.error.unwrap().code, ErrorCode::UnknownSession);
    }
}

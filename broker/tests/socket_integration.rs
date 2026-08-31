use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tempfile::tempdir;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::broadcast;
use tokio::time::timeout;
use uuid::Uuid;

use wolfpack_broker::codec::{
    read_frame_async, write_frame_async, Frame, OutputFrame, FRAME_KIND_CONTROL_REQUEST,
};
use wolfpack_broker::protocol::{
    methods, ControlRequest, ControlResponse, ErrorCode, Event, ResponsePayload, Status,
};
use wolfpack_broker::registry::Registry;
use wolfpack_broker::server::{start, Server, ServerConfig};
use wolfpack_broker::session_router::{SessionRouter, EVENT_BUS_CAPACITY};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

struct Harness {
    server: Option<Server>,
    socket_path: std::path::PathBuf,
    registry: Arc<Registry>,
    _dir: tempfile::TempDir,
}

impl Harness {
    async fn boot() -> Self {
        let dir = tempdir().expect("tempdir");
        let socket_path = dir.path().join("broker.sock");
        let (events, _) = broadcast::channel::<Event>(EVENT_BUS_CAPACITY);
        let registry = Arc::new(Registry::new(events.clone()));
        let server = start(ServerConfig {
            socket_path: socket_path.clone(),
            router: Arc::new(SessionRouter::new(Arc::clone(&registry), events.clone())),
            registry: Arc::clone(&registry),
            events,
            writer_queue_capacity: None,
        })
        .await
        .expect("server start");
        Self {
            server: Some(server),
            socket_path,
            registry,
            _dir: dir,
        }
    }

    async fn shutdown(mut self) {
        // Reap any sessions the test left behind so we don't leak children.
        for sess in self.registry.list() {
            let _ = sess.kill(libc::SIGKILL);
            let _ = sess.wait_for_exit(Duration::from_secs(5));
        }
        if let Some(server) = self.server.take() {
            server.shutdown().await;
        }
    }
}

async fn connect(path: &std::path::Path) -> UnixStream {
    timeout(TEST_TIMEOUT, UnixStream::connect(path))
        .await
        .expect("connect timeout")
        .expect("connect")
}

async fn round_trip(stream: &mut UnixStream, req: ControlRequest) -> ControlResponse {
    let id = req.id;
    let (mut r, mut w) = stream.split();
    write_frame_async(&mut w, &Frame::ControlRequest(req))
        .await
        .expect("write");
    // Async lifecycle events (`session_started`, `session_exited`, etc.)
    // can interleave on the wire with the matching control_response,
    // since both flow over the same socket. Drain past any incidental
    // event/output frames until the response with our id arrives. Tests
    // that need to assert on events use `await_event` to read the
    // post-response stream directly.
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = timeout(remaining, read_frame_async(&mut r))
            .await
            .expect("read timeout")
            .expect("read");
        match frame {
            Frame::ControlResponse(resp) if resp.id == id => return resp,
            Frame::Event(_) | Frame::OutputBinary(_) => continue,
            other => panic!("unexpected frame while awaiting response {id}: {other:?}"),
        }
    }
}

fn create_request(id: u64, name: Option<&str>, command: &[&str]) -> ControlRequest {
    ControlRequest {
        id,
        method: methods::CREATE_SESSION.into(),
        params: json!({
            "name": name,
            "cwd": "/tmp",
            "command": command,
            "cols": 80,
            "rows": 24,
        }),
    }
}

async fn poll_session_alive(stream: &mut UnixStream, session_id: Uuid) -> bool {
    let resp = round_trip(
        stream,
        ControlRequest {
            id: 9_999_999,
            method: methods::SESSION_INFO.into(),
            params: json!({ "session_id": session_id }),
        },
    )
    .await;
    match resp.payload.expect("payload") {
        ResponsePayload::SessionInfo { session } => session.alive,
        other => panic!("unexpected payload: {other:?}"),
    }
}

async fn wait_until_dead(stream: &mut UnixStream, session_id: Uuid) {
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    loop {
        if !poll_session_alive(stream, session_id).await {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("session {session_id} never transitioned to dead");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_then_list_returns_the_new_session() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        create_request(1, Some("alpha"), &["sleep", "30"]),
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };
    assert_eq!(created.name, "alpha");
    assert!(created.alive);

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::LIST_SESSIONS.into(),
            params: json!({}),
        },
    )
    .await;
    match resp.payload.expect("payload") {
        ResponsePayload::ListSessions { sessions } => {
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].id, created.id);
            assert_eq!(sessions[0].name, "alpha");
        }
        other => panic!("unexpected: {other:?}"),
    }

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn duplicate_name_returns_duplicate_session_name() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        create_request(1, Some("ralph"), &["sleep", "30"]),
    )
    .await;
    assert_eq!(resp.status, Status::Ok);

    let resp = round_trip(
        &mut stream,
        create_request(2, Some("ralph"), &["sleep", "30"]),
    )
    .await;
    assert_eq!(resp.status, Status::Error);
    assert_eq!(
        resp.error.expect("error").code,
        ErrorCode::DuplicateSessionName
    );

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn session_info_returns_session_for_known_id_and_unknown_session_for_missing_id() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        create_request(1, Some("info-target"), &["sleep", "30"]),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::SESSION_INFO.into(),
            params: json!({ "session_id": created.id }),
        },
    )
    .await;
    match resp.payload.expect("payload") {
        ResponsePayload::SessionInfo { session } => {
            assert_eq!(session.id, created.id);
            assert_eq!(session.name, "info-target");
        }
        other => panic!("unexpected: {other:?}"),
    }

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 3,
            method: methods::SESSION_INFO.into(),
            params: json!({ "session_id": Uuid::nil() }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Error);
    assert_eq!(
        resp.error.expect("error").code,
        ErrorCode::UnknownSession
    );

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn kill_session_transitions_alive_flag_to_false() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        create_request(1, Some("victim"), &["sleep", "30"]),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };
    assert!(poll_session_alive(&mut stream, created.id).await);

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::KILL_SESSION.into(),
            params: json!({ "session_id": created.id, "signal": libc::SIGTERM }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    match resp.payload.expect("payload") {
        ResponsePayload::KillSession { killed } => assert!(killed),
        other => panic!("unexpected: {other:?}"),
    }

    wait_until_dead(&mut stream, created.id).await;

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn killing_already_dead_session_returns_session_not_alive() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    // `true` exits immediately; we poll until the reaper flips alive=false
    // before issuing the second kill so we exercise the dead-session branch.
    let resp = round_trip(
        &mut stream,
        create_request(1, Some("flicker"), &["true"]),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };
    wait_until_dead(&mut stream, created.id).await;

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::KILL_SESSION.into(),
            params: json!({ "session_id": created.id, "signal": libc::SIGTERM }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Error);
    assert_eq!(
        resp.error.expect("error").code,
        ErrorCode::SessionNotAlive
    );

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn resize_round_trip_updates_session_info_and_snapshot_dimensions() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        create_request(1, Some("resize-target"), &["sleep", "30"]),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };
    assert_eq!((created.cols, created.rows), (80, 24));

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::RESIZE.into(),
            params: json!({ "session_id": created.id, "cols": 132, "rows": 50 }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    match resp.payload.expect("payload") {
        ResponsePayload::Resize { ok } => assert!(ok),
        other => panic!("unexpected: {other:?}"),
    }

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 3,
            method: methods::SESSION_INFO.into(),
            params: json!({ "session_id": created.id }),
        },
    )
    .await;
    match resp.payload.expect("payload") {
        ResponsePayload::SessionInfo { session } => {
            assert_eq!((session.cols, session.rows), (132, 50));
        }
        other => panic!("unexpected: {other:?}"),
    }

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 4,
            method: methods::SNAPSHOT.into(),
            params: json!({ "session_id": created.id }),
        },
    )
    .await;
    match resp.payload.expect("payload") {
        ResponsePayload::Snapshot { snapshot } => {
            assert_eq!((snapshot.cols, snapshot.rows), (132, 50));
            assert_eq!(snapshot.visible_screen.len(), 50);
        }
        other => panic!("unexpected: {other:?}"),
    }

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn snapshot_subscribe_establishes_atomic_live_cut() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;
    let resp = round_trip(
        &mut stream,
        create_request(1, Some("atomic-cut"), &["sh", "-c", "sleep 0.2; printf atomic-output; sleep 30"]),
    ).await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    let resp = round_trip(&mut stream, ControlRequest {
        id: 2,
        method: methods::SNAPSHOT_SUBSCRIBE.into(),
        params: json!({ "session_id": created.id, "scrollback_lines": 10 }),
    }).await;
    let snapshot_seq = match resp.payload.expect("payload") {
        ResponsePayload::SnapshotSubscribe { snapshot, current_seq, replay_truncated } => {
            assert_eq!(snapshot.seq, current_seq);
            assert!(!replay_truncated);
            snapshot.seq
        }
        other => panic!("unexpected: {other:?}"),
    };

    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match timeout(remaining, read_frame_async(&mut stream)).await.expect("output timeout").expect("output frame") {
            Frame::OutputBinary(output) if output.session_id == created.id => {
                assert!(output.seq > snapshot_seq);
                assert!(String::from_utf8_lossy(&output.data).contains("atomic-output"));
                break;
            }
            Frame::Event(_) => continue,
            other => panic!("unexpected frame after atomic subscribe: {other:?}"),
        }
    }

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn snapshot_subscribe_uses_snapshot_reflow_width_bounds() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;
    let resp = round_trip(
        &mut stream,
        create_request(1, Some("snapshot-widths"), &["sleep", "30"]),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    let narrow = round_trip(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::SNAPSHOT_SUBSCRIBE.into(),
            params: json!({ "session_id": created.id, "target_cols": 4 }),
        },
    )
    .await;
    assert_eq!(narrow.status, Status::Ok);

    let oversized = round_trip(
        &mut stream,
        ControlRequest {
            id: 3,
            method: methods::SNAPSHOT_SUBSCRIBE.into(),
            params: json!({ "session_id": created.id, "target_cols": 301 }),
        },
    )
    .await;
    assert_eq!(oversized.status, Status::Error);
    assert_eq!(
        oversized.error.expect("error").code,
        ErrorCode::InvalidRequest
    );

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn resize_unknown_session_returns_unknown_session() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 1,
            method: methods::RESIZE.into(),
            params: json!({ "session_id": Uuid::nil(), "cols": 132, "rows": 50 }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Error);
    assert_eq!(resp.error.expect("error").code, ErrorCode::UnknownSession);

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn spawning_nonexistent_command_returns_spawn_failed() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        create_request(
            1,
            Some("ghost"),
            &["/no/such/path/wolfpack-broker-test-bogus"],
        ),
    )
    .await;

    // posix_spawn semantics differ across libc versions: most platforms surface
    // ENOENT synchronously (Err → SpawnFailed), but some fork+exec, hand back
    // an `ok` envelope, and the child exits 127 immediately. Both outcomes are
    // acceptable; we just refuse to consider a still-alive session a pass.
    match resp.status {
        Status::Error => {
            assert_eq!(
                resp.error.expect("error").code,
                ErrorCode::SpawnFailed
            );
        }
        Status::Ok => {
            let session = match resp.payload.expect("payload") {
                ResponsePayload::CreateSession { session } => session,
                other => panic!("unexpected: {other:?}"),
            };
            wait_until_dead(&mut stream, session.id).await;
        }
    }

    drop(stream);
    h.shutdown().await;
}

// ---------------------------------------------------------------------------
// Transport-level coverage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn many_back_to_back_requests_on_one_connection() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    for id in 1..=10u64 {
        let resp = round_trip(
            &mut stream,
            ControlRequest {
                id,
                method: methods::LIST_SESSIONS.into(),
                params: json!({}),
            },
        )
        .await;
        assert_eq!(resp.id, id);
        assert_eq!(resp.status, Status::Ok);
    }

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn multiple_concurrent_clients_are_served_independently() {
    let h = Harness::boot().await;

    let mut tasks = Vec::new();
    for id in 0..4u64 {
        let path = h.socket_path.clone();
        tasks.push(tokio::spawn(async move {
            let mut stream = connect(&path).await;
            let resp = round_trip(
                &mut stream,
                ControlRequest {
                    id: id + 100,
                    method: methods::LIST_SESSIONS.into(),
                    params: json!({}),
                },
            )
            .await;
            assert_eq!(resp.id, id + 100);
            assert_eq!(resp.status, Status::Ok);
        }));
    }
    for t in tasks {
        t.await.expect("client task");
    }

    h.shutdown().await;
}

#[tokio::test]
async fn broker_drops_connection_on_protocol_violation() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    // Unknown frame kind byte → broker logs and closes the connection.
    let bogus = [0xFFu8, 0x00, 0x00, 0x00, 0x00];
    stream.write_all(&bogus).await.expect("write");

    let result = timeout(TEST_TIMEOUT, async {
        let (mut r, _w) = stream.split();
        read_frame_async(&mut r).await
    })
    .await
    .expect("read timeout");
    assert!(
        result.is_err(),
        "expected the connection to be closed: {result:?}"
    );

    h.shutdown().await;
}

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe (live output fanout)
// ---------------------------------------------------------------------------

/// Send a control_request and drain frames from the connection until the
/// matching control_response arrives. Output frames that interleave with
/// the response (replay frames, in-flight live frames) are appended to
/// `output` instead of failing the test.
async fn request_collecting_output(
    stream: &mut UnixStream,
    req: ControlRequest,
    output: &mut Vec<OutputFrame>,
) -> ControlResponse {
    let id = req.id;
    let (mut r, mut w) = stream.split();
    write_frame_async(&mut w, &Frame::ControlRequest(req))
        .await
        .expect("write control_request");
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = timeout(remaining, read_frame_async(&mut r))
            .await
            .expect("frame timeout")
            .expect("frame read");
        match frame {
            Frame::ControlResponse(resp) if resp.id == id => return resp,
            Frame::OutputBinary(out) => output.push(out),
            // Lifecycle events flow over the same socket as control responses
            // and may interleave; they are not relevant to subscribe-output
            // tests, so discard them rather than failing.
            Frame::Event(_) => continue,
            other => panic!("unexpected frame while awaiting response {id}: {other:?}"),
        }
    }
}

/// Collect output_binary frames until either we've gathered enough bytes
/// to satisfy `min_bytes` OR the deadline trips. Bytes are accumulated
/// across all frames for the matching session.
async fn collect_output_until(
    stream: &mut UnixStream,
    session_id: Uuid,
    min_bytes: usize,
    deadline: tokio::time::Instant,
) -> Vec<OutputFrame> {
    let (mut r, _w) = stream.split();
    let mut frames = Vec::new();
    let mut total = 0usize;
    while total < min_bytes {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match timeout(remaining, read_frame_async(&mut r)).await {
            Ok(Ok(Frame::OutputBinary(out))) if out.session_id == session_id => {
                total += out.data.len();
                frames.push(out);
            }
            Ok(Ok(Frame::OutputBinary(_))) => continue,
            // Async lifecycle events share the wire with output frames;
            // tests that focus on output coverage just discard them.
            Ok(Ok(Frame::Event(_))) => continue,
            Ok(Ok(other)) => panic!("unexpected frame while collecting output: {other:?}"),
            Ok(Err(e)) => panic!("read error while collecting output: {e:?}"),
            Err(_) => break,
        }
    }
    frames
}

#[tokio::test]
async fn subscribe_streams_live_pty_output_to_subscriber() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    // `sleep 30` keeps the PTY (and therefore the OutputBus) open so the
    // subscribe call below can attach a live receiver — if the child
    // exits before subscribe, the drainer closes the bus and subscribe
    // would correctly surface session_not_alive (covered by a separate
    // test). Here we want to exercise the live fanout path end-to-end.
    let resp = round_trip(
        &mut stream,
        create_request(
            1,
            Some("live"),
            &["bash", "-c", "printf wolfpack-live-test; sleep 30"],
        ),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    // since_seq=0 so the replay slice picks up `printf` bytes that may
    // already be in the ring by the time this RPC reaches the broker —
    // otherwise the test races the child's PTY write against subscribe
    // attach and flakes when printf wins.
    let mut output: Vec<OutputFrame> = Vec::new();
    let resp = request_collecting_output(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::SUBSCRIBE.into(),
            params: json!({ "session_id": created.id, "since_seq": 0 }),
        },
        &mut output,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    match resp.payload.expect("payload") {
        ResponsePayload::Subscribe { ok, current_seq: _, replay_truncated: _ } => assert!(ok),
        other => panic!("unexpected: {other:?}"),
    }

    // After the response, collect frames until we've seen the printed
    // bytes (or timeout). The PTY may buffer/flush in chunks, so allow
    // multiple frames to assemble the payload.
    let mut more = collect_output_until(
        &mut stream,
        created.id,
        b"wolfpack-live-test".len(),
        tokio::time::Instant::now() + TEST_TIMEOUT,
    )
    .await;
    output.append(&mut more);

    let assembled: Vec<u8> = output.iter().flat_map(|f| f.data.iter().copied()).collect();
    let assembled_str = String::from_utf8_lossy(&assembled);
    assert!(
        assembled_str.contains("wolfpack-live-test"),
        "expected live bytes 'wolfpack-live-test' on subscriber, got {assembled_str:?}"
    );

    // Seqs must be strictly increasing, which is the cross-frame contract
    // a client uses to dedupe replay vs live.
    let seqs: Vec<u64> = output.iter().map(|f| f.seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(seqs, sorted, "seqs must be monotonic and unique: {seqs:?}");
    assert!(seqs.iter().all(|s| *s >= 1), "seqs are 1-indexed: {seqs:?}");

    // Kill the long-running session before harness shutdown.
    let _ = round_trip(
        &mut stream,
        ControlRequest {
            id: 99,
            method: methods::KILL_SESSION.into(),
            params: json!({ "session_id": created.id, "signal": libc::SIGKILL }),
        },
    )
    .await;

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn subscribe_after_drainer_close_replays_retained_final_output() {
    let h = Harness::boot().await;
    let session = h
        .registry
        .create(wolfpack_broker::registry::CreateOptions {
            name: Some("closed".into()),
            cwd: "/tmp".into(),
            command: vec!["printf".into(), "first-then-done".into()],
            env: vec![],
            cols: 80,
            rows: 24,
        })
        .expect("create session");
    let session_id = session.id();
    let bus = session.output_bus();
    assert!(bus.wait_closed(Duration::from_secs(5)));
    assert!(bus.current_seq() >= 1, "drainer must have published");

    let mut stream = connect(&h.socket_path).await;
    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 1,
            method: methods::SUBSCRIBE.into(),
            params: json!({ "session_id": session_id, "since_seq": 0 }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Ok, "closed buses remain replayable during tombstone retention");
    let output = timeout(TEST_TIMEOUT, read_frame_async(&mut stream))
        .await
        .expect("final replay timeout")
        .expect("final replay frame");
    match output {
        Frame::OutputBinary(frame) => assert!(String::from_utf8_lossy(&frame.data).contains("first-then-done")),
        other => panic!("expected final output replay, got {other:?}"),
    }

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn subscribe_with_since_seq_replays_then_streams_live() {
    let h = Harness::boot().await;

    // `sleep 30` keeps the bus alive; we publish synthetic bytes by
    // spawning a child that prints, then verify replay via since_seq
    // captured from a snapshot before subscribing.
    let mut stream = connect(&h.socket_path).await;
    let resp = round_trip(
        &mut stream,
        create_request(
            1,
            Some("replay-live"),
            &["bash", "-c", "printf one; sleep 0.05; printf two; sleep 30"],
        ),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    // Wait until the bus has published at least one chunk so the ring
    // has something to replay. The exact chunk count depends on PTY
    // read coalescing — what matters is that bytes are buffered before
    // we subscribe with since_seq=0.
    let session = h.registry.get(created.id).expect("session in registry");
    let bus = session.output_bus();
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    while bus.current_seq() < 1 {
        if tokio::time::Instant::now() >= deadline {
            panic!("drainer never published a chunk");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Subscribe with since_seq=0 to receive the buffered chunks plus
    // anything live afterwards. The bus is still open (sleep 30 keeps
    // the PTY alive), so subscribe attaches a live receiver.
    let mut output: Vec<OutputFrame> = Vec::new();
    let resp = request_collecting_output(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::SUBSCRIBE.into(),
            params: json!({ "session_id": created.id, "since_seq": 0 }),
        },
        &mut output,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    let current_seq = match resp.payload.expect("payload") {
        ResponsePayload::Subscribe { ok, current_seq, replay_truncated: _ } => {
            assert!(ok);
            current_seq
        }
        other => panic!("unexpected: {other:?}"),
    };
    assert!(current_seq >= 1, "current_seq = {current_seq}");

    // Collect output until we see both "one" and "two" assembled.
    let needle_bytes = b"onetwo".len();
    let mut more = collect_output_until(
        &mut stream,
        created.id,
        needle_bytes,
        tokio::time::Instant::now() + TEST_TIMEOUT,
    )
    .await;
    output.append(&mut more);

    let assembled: String = output
        .iter()
        .flat_map(|f| f.data.iter().copied())
        .map(|b| b as char)
        .collect();
    assert!(
        assembled.contains("one") && assembled.contains("two"),
        "replay+live should include both 'one' and 'two', got: {assembled:?}"
    );

    // Cleanup: kill the long-running sleep so the harness shutdown is fast.
    let _ = round_trip(
        &mut stream,
        ControlRequest {
            id: 99,
            method: methods::KILL_SESSION.into(),
            params: json!({ "session_id": created.id, "signal": libc::SIGKILL }),
        },
    )
    .await;

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn unsubscribe_stops_further_output_frames() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    // bash loop prints continuously; we'll subscribe, see some bytes,
    // unsubscribe, and verify no NEW frames arrive after unsubscribe.
    let resp = round_trip(
        &mut stream,
        create_request(
            1,
            Some("chatty"),
            &[
                "bash",
                "-c",
                "while true; do printf tick; sleep 0.05; done",
            ],
        ),
    )
    .await;
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    // Subscribe.
    let mut output: Vec<OutputFrame> = Vec::new();
    let resp = request_collecting_output(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::SUBSCRIBE.into(),
            params: json!({ "session_id": created.id }),
        },
        &mut output,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);

    // Wait for at least one live frame to confirm the stream is active.
    let pre = collect_output_until(
        &mut stream,
        created.id,
        b"tick".len(),
        tokio::time::Instant::now() + TEST_TIMEOUT,
    )
    .await;
    assert!(!pre.is_empty(), "expected live ticks before unsubscribe");

    // Unsubscribe. Output frames in flight at unsubscribe time may still
    // arrive — that's documented protocol behaviour, so we let the helper
    // collect them rather than asserting silence yet.
    let mut in_flight: Vec<OutputFrame> = Vec::new();
    let resp = request_collecting_output(
        &mut stream,
        ControlRequest {
            id: 3,
            method: methods::UNSUBSCRIBE.into(),
            params: json!({ "session_id": created.id }),
        },
        &mut in_flight,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    match resp.payload.expect("payload") {
        ResponsePayload::Unsubscribe { ok } => assert!(ok),
        other => panic!("unexpected: {other:?}"),
    }

    // After unsubscribe + a settle window, no new output_binary frames
    // should arrive on the connection. We give an explicit grace for
    // already-queued frames (one wave), then assert silence.
    let _drain = collect_output_until(
        &mut stream,
        created.id,
        usize::MAX,
        tokio::time::Instant::now() + Duration::from_millis(200),
    )
    .await;
    let post = collect_output_until(
        &mut stream,
        created.id,
        1,
        tokio::time::Instant::now() + Duration::from_millis(300),
    )
    .await;
    assert!(
        post.is_empty(),
        "no frames should arrive after unsubscribe + settle, got {post:?}"
    );

    // Kill the chatty session before harness shutdown so we don't leak.
    let _ = round_trip(
        &mut stream,
        ControlRequest {
            id: 99,
            method: methods::KILL_SESSION.into(),
            params: json!({ "session_id": created.id, "signal": libc::SIGKILL }),
        },
    )
    .await;

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn subscribe_unknown_session_returns_unknown_session() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 1,
            method: methods::SUBSCRIBE.into(),
            params: json!({ "session_id": Uuid::nil() }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Error);
    assert_eq!(resp.error.expect("error").code, ErrorCode::UnknownSession);

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn unsubscribe_for_session_not_subscribed_is_idempotent_ok() {
    // Per protocol: unsubscribe is idempotent. Hitting it for a session
    // we never subscribed to (or already unsubscribed from) returns
    // ok=true rather than an error.
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    let resp = round_trip(
        &mut stream,
        ControlRequest {
            id: 1,
            method: methods::UNSUBSCRIBE.into(),
            params: json!({ "session_id": Uuid::nil() }),
        },
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    match resp.payload.expect("payload") {
        ResponsePayload::Unsubscribe { ok } => assert!(ok),
        other => panic!("unexpected: {other:?}"),
    }

    drop(stream);
    h.shutdown().await;
}

/// After unsubscribing session A and immediately subscribing a new session B
/// (that happens to be assigned the same UUID — not possible in production
/// since UUIDs are random, but the re-use scenario is: same session recycled
/// via kill+create with the same UUID slot in the registry, which cannot
/// happen with random v4 UUIDs). This test instead verifies the weaker but
/// testable invariant: unsubscribing A and subscribing B on the same connection
/// delivers only B's output, not A's. It exercises the idempotent re-subscribe
/// logic (old forwarder aborted before new one starts).
#[tokio::test]
async fn resubscribe_after_unsubscribe_delivers_only_new_session_output() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;

    // Create two sessions — A (fast ticker) and B (also a ticker).
    let resp_a = round_trip(&mut stream, create_request(1, Some("a"), &["sh", "-c", "while true; do echo a; sleep 0.05; done"])).await;
    let id_a = match resp_a.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session.id,
        other => panic!("unexpected: {other:?}"),
    };

    let resp_b = round_trip(&mut stream, create_request(2, Some("b"), &["sh", "-c", "while true; do echo b; sleep 0.05; done"])).await;
    let id_b = match resp_b.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session.id,
        other => panic!("unexpected: {other:?}"),
    };

    // Subscribe to A.
    round_trip(&mut stream, ControlRequest {
        id: 3,
        method: methods::SUBSCRIBE.into(),
        params: json!({ "session_id": id_a }),
    }).await;

    // Drain frames from A to confirm it's flowing. Under parallel cargo test
    // load, the shell/timer can take longer than a fixed 120ms sleep to emit.
    let (mut r, _w) = stream.split();
    let mut a_frames = 0u32;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Ok(frame)) = timeout(Duration::from_millis(100), read_frame_async(&mut r)).await {
            if matches!(frame, Frame::OutputBinary(ref f) if f.session_id == id_a) {
                a_frames += 1;
                break;
            }
        }
    }
    assert!(a_frames >= 1, "expected at least one output frame from A");

    // Unsubscribe A, then immediately subscribe B.
    round_trip(&mut stream, ControlRequest {
        id: 4,
        method: methods::UNSUBSCRIBE.into(),
        params: json!({ "session_id": id_a }),
    }).await;
    round_trip(&mut stream, ControlRequest {
        id: 5,
        method: methods::SUBSCRIBE.into(),
        params: json!({ "session_id": id_b }),
    }).await;

    // Collect output frames for 200ms. All must belong to B, not A.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (mut r2, _w2) = stream.split();
    let mut a_after = 0u32;
    let mut b_after = 0u32;
    loop {
        match timeout(Duration::from_millis(50), read_frame_async(&mut r2)).await {
            Ok(Ok(Frame::OutputBinary(f))) => {
                if f.session_id == id_a { a_after += 1; }
                else if f.session_id == id_b { b_after += 1; }
            }
            Ok(Ok(Frame::Event(_))) => {} // lifecycle events are expected
            _ => break,
        }
    }
    assert!(b_after > 0, "expected output from B after resubscribe");
    assert_eq!(a_after, 0, "no frames from A should arrive after unsubscribe, got {a_after}");

    // Kill both sessions.
    let _ = round_trip(&mut stream, ControlRequest {
        id: 6,
        method: methods::KILL_SESSION.into(),
        params: json!({ "session_id": id_a, "signal": libc::SIGKILL }),
    }).await;
    let _ = round_trip(&mut stream, ControlRequest {
        id: 7,
        method: methods::KILL_SESSION.into(),
        params: json!({ "session_id": id_b, "signal": libc::SIGKILL }),
    }).await;

    drop(stream);
    h.shutdown().await;
}

// ---------------------------------------------------------------------------
// Async events
// ---------------------------------------------------------------------------

/// Send a control_request and drain frames until the matching response
/// arrives, pushing any interleaving event/output frames into the
/// supplied buffers. This is the round-trip helper for tests that need
/// to assert on async events: events that arrive before the response
/// (a possible scheduling outcome since events fire from registry/reaper
/// off-task) end up in `events` rather than tripping the panic.
async fn round_trip_with_events(
    stream: &mut UnixStream,
    req: ControlRequest,
    events: &mut Vec<Event>,
) -> ControlResponse {
    let id = req.id;
    let (mut r, mut w) = stream.split();
    write_frame_async(&mut w, &Frame::ControlRequest(req))
        .await
        .expect("write");
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = timeout(remaining, read_frame_async(&mut r))
            .await
            .expect("read timeout")
            .expect("read");
        match frame {
            Frame::ControlResponse(resp) if resp.id == id => return resp,
            Frame::Event(ev) => events.push(ev),
            Frame::OutputBinary(_) => continue,
            other => panic!("unexpected frame while awaiting response {id}: {other:?}"),
        }
    }
}

/// Drain frames until an `Event` matching `predicate` is seen, or the
/// deadline trips. Pulls from `buffer` first (events buffered by an
/// earlier `round_trip_with_events`); when the buffer is empty, reads
/// further frames from the wire. Non-matching events stay in the
/// buffer for later assertions.
async fn await_event_buffered(
    stream: &mut UnixStream,
    buffer: &mut Vec<Event>,
    deadline: tokio::time::Instant,
    mut predicate: impl FnMut(&Event) -> bool,
) -> Event {
    if let Some(idx) = buffer.iter().position(&mut predicate) {
        return buffer.remove(idx);
    }
    let (mut r, _w) = stream.split();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("await_event_buffered timed out");
        }
        let frame = timeout(remaining, read_frame_async(&mut r))
            .await
            .expect("frame read timeout")
            .expect("frame read");
        match frame {
            Frame::Event(ev) if predicate(&ev) => return ev,
            Frame::Event(ev) => buffer.push(ev),
            Frame::ControlResponse(_) => continue,
            Frame::OutputBinary(_) => continue,
            other => panic!("unexpected frame while awaiting event: {other:?}"),
        }
    }
}

/// End-to-end coverage for the async event plane. Asserts that a connected
/// client sees:
///   * `session_started`     after `create_session` lands
///   * `session_resized`     after `resize`
///   * `snapshot_invalidated` after `resize`
///   * `session_exited`      after the reaper observes the killed child
#[tokio::test]
async fn lifecycle_events_are_delivered_to_connected_client() {
    let h = Harness::boot().await;
    let mut stream = connect(&h.socket_path).await;
    let mut events: Vec<Event> = Vec::new();

    // create → expect session_started.
    let resp = round_trip_with_events(
        &mut stream,
        create_request(1, Some("evented"), &["sleep", "30"]),
        &mut events,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    match await_event_buffered(&mut stream, &mut events, deadline, |ev| {
        matches!(ev, Event::SessionStarted { session } if session.id == created.id)
    })
    .await
    {
        Event::SessionStarted { session } => {
            assert_eq!(session.id, created.id);
            assert_eq!(session.name, "evented");
        }
        other => panic!("unexpected: {other:?}"),
    }

    // resize → expect session_resized + snapshot_invalidated.
    let resp = round_trip_with_events(
        &mut stream,
        ControlRequest {
            id: 2,
            method: methods::RESIZE.into(),
            params: json!({ "session_id": created.id, "cols": 132, "rows": 50 }),
        },
        &mut events,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);

    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    match await_event_buffered(&mut stream, &mut events, deadline, |ev| {
        matches!(ev, Event::SessionResized { session_id, .. } if *session_id == created.id)
    })
    .await
    {
        Event::SessionResized { cols, rows, .. } => {
            assert_eq!((cols, rows), (132, 50));
        }
        other => panic!("unexpected: {other:?}"),
    }
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    match await_event_buffered(&mut stream, &mut events, deadline, |ev| {
        matches!(ev, Event::SnapshotInvalidated { session_id } if *session_id == created.id)
    })
    .await
    {
        Event::SnapshotInvalidated { session_id } => assert_eq!(session_id, created.id),
        other => panic!("unexpected: {other:?}"),
    }

    // kill → expect session_exited from the reaper.
    let resp = round_trip_with_events(
        &mut stream,
        ControlRequest {
            id: 3,
            method: methods::KILL_SESSION.into(),
            params: json!({ "session_id": created.id, "signal": libc::SIGKILL }),
        },
        &mut events,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);

    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    match await_event_buffered(&mut stream, &mut events, deadline, |ev| {
        matches!(ev, Event::SessionExited { session_id, .. } if *session_id == created.id)
    })
    .await
    {
        Event::SessionExited { session_id, .. } => assert_eq!(session_id, created.id),
        other => panic!("unexpected: {other:?}"),
    }

    drop(stream);
    h.shutdown().await;
}

#[tokio::test]
async fn events_fan_out_to_every_connected_client() {
    let h = Harness::boot().await;
    let mut a = connect(&h.socket_path).await;
    let mut b = connect(&h.socket_path).await;
    let mut a_events: Vec<Event> = Vec::new();
    let mut b_events: Vec<Event> = Vec::new();

    // Create on connection A; both A and B must see session_started.
    let resp = round_trip_with_events(
        &mut a,
        create_request(1, Some("fanout"), &["sleep", "30"]),
        &mut a_events,
    )
    .await;
    assert_eq!(resp.status, Status::Ok);
    let created = match resp.payload.expect("payload") {
        ResponsePayload::CreateSession { session } => session,
        other => panic!("unexpected: {other:?}"),
    };

    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    let _ = await_event_buffered(&mut a, &mut a_events, deadline, |ev| {
        matches!(ev, Event::SessionStarted { session } if session.id == created.id)
    })
    .await;
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    let _ = await_event_buffered(&mut b, &mut b_events, deadline, |ev| {
        matches!(ev, Event::SessionStarted { session } if session.id == created.id)
    })
    .await;

    // Cleanup the long-running sleep so harness shutdown is fast.
    let _ = round_trip_with_events(
        &mut a,
        ControlRequest {
            id: 99,
            method: methods::KILL_SESSION.into(),
            params: json!({ "session_id": created.id, "signal": libc::SIGKILL }),
        },
        &mut a_events,
    )
    .await;

    drop(a);
    drop(b);
    h.shutdown().await;
}

// ── Socket ownership and permission tests ───────────────────────────────────

fn test_server_config(socket_path: std::path::PathBuf) -> ServerConfig {
    let (events, _) = broadcast::channel::<Event>(EVENT_BUS_CAPACITY);
    let registry = Arc::new(Registry::new(events.clone()));
    ServerConfig {
        socket_path,
        router: Arc::new(SessionRouter::new(Arc::clone(&registry), events.clone())),
        registry,
        events,
        writer_queue_capacity: None,
    }
}

#[tokio::test]
async fn second_server_refuses_to_replace_a_live_broker_socket() {
    let h = Harness::boot().await;

    match start(test_server_config(h.socket_path.clone())).await {
        Ok(second) => {
            second.shutdown().await;
            h.shutdown().await;
            panic!("second server replaced the live broker socket");
        }
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse),
    }

    let mut stream = connect(&h.socket_path).await;
    let response = round_trip(
        &mut stream,
        ControlRequest {
            id: 1,
            method: methods::LIST_SESSIONS.into(),
            params: json!({}),
        },
    )
    .await;
    assert_eq!(response.status, Status::Ok);

    h.shutdown().await;
}

#[tokio::test]
async fn stale_socket_is_removed_before_binding() {
    let dir = tempdir().expect("tempdir");
    let socket_path = dir.path().join("broker.sock");
    let stale = std::os::unix::net::UnixListener::bind(&socket_path).expect("bind stale socket");
    drop(stale);

    let server = start(test_server_config(socket_path.clone()))
        .await
        .expect("replace stale socket");
    assert!(UnixStream::connect(&socket_path).await.is_ok());
    server.shutdown().await;
}

#[tokio::test]
async fn startup_does_not_delete_a_non_socket_path() {
    let dir = tempdir().expect("tempdir");
    let socket_path = dir.path().join("broker.sock");
    std::fs::write(&socket_path, b"keep me").expect("write sentinel");

    match start(test_server_config(socket_path.clone())).await {
        Ok(server) => {
            server.shutdown().await;
            panic!("server replaced a non-socket path");
        }
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists),
    }
    assert_eq!(
        std::fs::read(&socket_path).expect("read sentinel"),
        b"keep me"
    );
}

/// The socket file must be created with mode 0o600 so that only the owning
/// user can connect to the broker. No TOCTOU window should allow a second
/// user to connect before chmod runs (enforced via umask in server::start).
#[tokio::test]
async fn socket_file_has_mode_0600() {
    let h = Harness::boot().await;

    let meta = std::fs::metadata(&h.socket_path).expect("stat socket");
    let mode = meta.permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "socket must have mode 0o600, got 0o{mode:03o}"
    );

    h.shutdown().await;
}

/// Using a custom socket path (not ~/.wolfpack) must also produce a 0o600
/// socket — the umask fix is unconditional, not path-pattern-gated.
#[tokio::test]
async fn socket_file_has_mode_0600_custom_path() {
    // Boot using a deeply nested custom path (not the default ~/.wolfpack name)
    let dir = tempfile::tempdir().expect("tempdir");
    let socket_path = dir.path().join("custom").join("sub").join("broker.sock");

    let (events, _) = tokio::sync::broadcast::channel::<wolfpack_broker::protocol::Event>(
        wolfpack_broker::session_router::EVENT_BUS_CAPACITY,
    );
    let registry = std::sync::Arc::new(Registry::new(events.clone()));
    let server = start(ServerConfig {
        socket_path: socket_path.clone(),
        router: std::sync::Arc::new(wolfpack_broker::session_router::SessionRouter::new(
            std::sync::Arc::clone(&registry),
            events.clone(),
        )),
        registry: std::sync::Arc::clone(&registry),
        events,
        writer_queue_capacity: None,
    })
    .await
    .expect("server start");

    let meta = std::fs::metadata(&socket_path).expect("stat socket");
    let mode = meta.permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "socket must have mode 0o600, got 0o{mode:03o}"
    );

    // Parent directory must be 0o700
    let parent = socket_path.parent().unwrap();
    let parent_meta = std::fs::metadata(parent).expect("stat parent");
    let parent_mode = parent_meta.permissions().mode() & 0o777;
    assert_eq!(
        parent_mode, 0o700,
        "socket parent dir must have mode 0o700, got 0o{parent_mode:03o}"
    );

    server.shutdown().await;
}

// ── Failure-mode tests ────────────────────────────────────────────────────────

/// A frame whose payload is syntactically invalid JSON must cause the server
/// to drop that connection (codec returns `CodecError::Json`). The server
/// itself must survive and accept new connections.
#[tokio::test]
async fn malformed_json_frame_drops_connection() {
    let h = Harness::boot().await;
    let mut bad = connect(&h.socket_path).await;

    let payload = b"{not valid json!";
    let mut raw = vec![FRAME_KIND_CONTROL_REQUEST];
    raw.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    raw.extend_from_slice(payload);
    bad.write_all(&raw).await.expect("write raw frame");

    let (mut r, _w) = bad.split();
    let res = timeout(TEST_TIMEOUT, read_frame_async(&mut r)).await;
    match res {
        Ok(Ok(frame)) => panic!("expected connection drop after malformed JSON, got {frame:?}"),
        _ => {} // EOF, codec error, or timeout — all mean the connection is gone
    }

    // Server must still be alive and functional.
    let mut good = connect(&h.socket_path).await;
    let resp = round_trip(
        &mut good,
        ControlRequest { id: 1, method: methods::LIST_SESSIONS.into(), params: json!({}) },
    )
    .await;
    assert_eq!(resp.status, Status::Ok);

    drop(good);
    h.shutdown().await;
}

/// A frame header announcing a payload larger than MAX_FRAME_PAYLOAD (16 MiB)
/// must cause the server to drop that connection immediately, without reading
/// the announced payload. Other connections must continue working.
#[tokio::test]
async fn oversized_frame_drops_connection_server_survives() {
    let h = Harness::boot().await;
    let mut bad = connect(&h.socket_path).await;

    // Send only the 5-byte header with length 0xFFFF_FFFF (>> MAX_FRAME_PAYLOAD).
    let mut raw = vec![FRAME_KIND_CONTROL_REQUEST];
    raw.extend_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
    bad.write_all(&raw).await.expect("write oversized header");

    let (mut r, _w) = bad.split();
    let res = timeout(TEST_TIMEOUT, read_frame_async(&mut r)).await;
    match res {
        Ok(Ok(frame)) => panic!("expected connection drop for oversized frame, got {frame:?}"),
        _ => {}
    }

    // Server must still be alive.
    let mut good = connect(&h.socket_path).await;
    let resp = round_trip(
        &mut good,
        ControlRequest { id: 1, method: methods::LIST_SESSIONS.into(), params: json!({}) },
    )
    .await;
    assert_eq!(resp.status, Status::Ok);

    drop(good);
    h.shutdown().await;
}

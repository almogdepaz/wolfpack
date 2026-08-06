use std::collections::{HashMap, VecDeque};
use std::io;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::codec::{read_frame_async, write_frame_async, CodecError, Frame, InputFrame, OutputFrame, MAX_INPUT_BINARY_PAYLOAD};
use crate::protocol::{
    methods, ControlRequest, ControlResponse, ErrorCode, Event, ProtocolError, ResponsePayload,
    SnapshotParams, SubscribeParams, UnsubscribeParams,
};
use crate::registry::Registry;
use crate::ring_buffer::OutputChunk;
use crate::router::Router;
use crate::session::EventSender;

/// Per-connection queue depth. Control/global lifecycle and output use separate
/// queues so PTY traffic cannot starve request responses; the socket writer
/// prioritises control while preserving order within each queue.
const WRITER_QUEUE_CAPACITY: usize = 1024;
/// Merge adjacent PTY reads before crossing the broker socket without raising
/// the writer queue's pre-coalescing memory envelope (1,024 × 8 KiB).
const OUTPUT_FRAME_COALESCE_MAX_BYTES: usize = 8 * 1024;
/// Keep draining live broadcast output while the socket writer is blocked,
/// but bound per-subscription memory. At the cap we drain queued frames first;
/// sustained producers then hit the existing broadcast-lag recovery contract.
const OUTPUT_FORWARD_BUFFER_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Input is ordered per connection and bounded by bytes: the codec caps each
/// frame and this depth caps queued data before socket backpressure applies.
const INPUT_QUEUE_MAX_BYTES: usize = 4 * 1024 * 1024;
const INPUT_QUEUE_CAPACITY: usize = INPUT_QUEUE_MAX_BYTES / MAX_INPUT_BINARY_PAYLOAD as usize;

pub struct ServerConfig {
    pub socket_path: PathBuf,
    pub router: Arc<dyn Router + Send + Sync>,
    /// Required for `subscribe`/`unsubscribe`: the connection layer needs
    /// the live `Session` to attach to its `OutputBus`. The router could
    /// also reach the registry indirectly, but plumbing it explicitly
    /// keeps the streaming-path dependency obvious.
    pub registry: Arc<Registry>,
    /// Async-event fanout. Every accepted connection subscribes here so
    /// lifecycle events (`session_started`, `session_exited`,
    /// `session_resized`, `snapshot_invalidated`) reach every connected
    /// client. This is the same sender held by the registry, by every
    /// session's reaper, and by the router's resize path — see
    /// [`crate::session::EventSender`].
    pub events: EventSender,
    /// Override each per-connection writer queue depth. `None` → use the
    /// production default (1024). Only set this in tests that need small
    /// control/output queues to trigger backpressure quickly.
    pub writer_queue_capacity: Option<usize>,
}

pub struct Server {
    socket_path: PathBuf,
    shutdown_tx: watch::Sender<bool>,
    accept_task: JoinHandle<()>,
}

impl Server {
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        if let Err(e) = self.accept_task.await {
            warn!(error = %e, "broker accept task join error");
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Resolves the canonical broker socket path, matching docs/broker-protocol.md.
pub fn default_socket_path() -> PathBuf {
    if let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR") {
        let mut p = PathBuf::from(rt);
        p.push("wolfpack-broker.sock");
        return p;
    }
    let mut p = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    p.push(".wolfpack");
    p.push("broker.sock");
    p
}

pub async fn start(config: ServerConfig) -> io::Result<Server> {
    let ServerConfig {
        socket_path,
        router,
        registry,
        events,
        writer_queue_capacity,
    } = config;
    let writer_queue_capacity = writer_queue_capacity.unwrap_or(WRITER_QUEUE_CAPACITY);

    if let Some(parent) = socket_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
            // Harden the parent dir so a new socket created there before chmod
            // runs is not reachable by other local users. XDG_RUNTIME_DIR is
            // already 0o700 per spec, but for all other paths (e.g. ~/.wolfpack
            // or any custom path) we set it explicitly. This is belt-and-suspenders
            // alongside the umask below.
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    prepare_socket_path(&socket_path).await?;

    // Set umask to 0o077 before bind so the kernel creates the socket file
    // with mode 0o600 directly, eliminating the TOCTOU window between bind
    // and the chmod below. Restore umask immediately after bind.
    let old_umask = unsafe { libc::umask(0o077) };
    let bind_result = UnixListener::bind(&socket_path);
    unsafe { libc::umask(old_umask) };
    let listener = bind_result?;
    // Belt-and-suspenders: also chmod in case of an unusual kernel that does
    // not honour umask for Unix sockets.
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
    info!(socket = %socket_path.display(), "broker listening");

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let accept_task = tokio::spawn(accept_loop(
        listener,
        router,
        registry,
        events,
        writer_queue_capacity,
        shutdown_rx,
    ));

    Ok(Server {
        socket_path,
        shutdown_tx,
        accept_task,
    })
}

async fn prepare_socket_path(socket_path: &Path) -> io::Result<()> {
    let metadata = match std::fs::symlink_metadata(socket_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "refusing to replace non-socket path {}",
                socket_path.display()
            ),
        ));
    }

    match UnixStream::connect(socket_path).await {
        Ok(stream) => {
            drop(stream);
            Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("broker already listening at {}", socket_path.display()),
            ))
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            match std::fs::remove_file(socket_path) {
                Ok(()) => Ok(()),
                Err(remove_error) if remove_error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(remove_error) => Err(remove_error),
            }
        }
        Err(error) => Err(error),
    }
}

async fn accept_loop(
    listener: UnixListener,
    router: Arc<dyn Router + Send + Sync>,
    registry: Arc<Registry>,
    events: EventSender,
    writer_queue_capacity: usize,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            biased;
            res = shutdown.changed() => {
                if res.is_err() || *shutdown.borrow() {
                    info!("broker shutdown requested; closing listener");
                    break;
                }
            }
            accept = listener.accept() => match accept {
                Ok((stream, _)) => {
                    let r = router.clone();
                    let reg = Arc::clone(&registry);
                    // Subscribe to events SYNCHRONOUSLY here, before the
                    // connection task is even scheduled, so a client that
                    // issues a request immediately after connect can't
                    // miss the event the request publishes. (The forwarder
                    // task later just drains this receiver.)
                    let event_rx = events.subscribe();
                    let conn_shutdown = shutdown.clone();
                    tokio::spawn(handle_connection(
                        stream,
                        r,
                        reg,
                        event_rx,
                        writer_queue_capacity,
                        conn_shutdown,
                    ));
                }
                Err(e) => {
                    error!(error = %e, "broker accept error");
                }
            },
        }
    }
}

async fn handle_connection(
    stream: UnixStream,
    router: Arc<dyn Router + Send + Sync>,
    registry: Arc<Registry>,
    event_rx: broadcast::Receiver<Event>,
    writer_queue_cap: usize,
    mut shutdown: watch::Receiver<bool>,
) {
    debug!("broker connection opened");
    let (mut read_half, write_half) = stream.into_split();

    // Control responses/global lifecycle events must not queue behind a PTY
    // redraw burst. The socket writer prioritises this queue over output.
    let (writer_tx, writer_rx) = mpsc::channel::<Frame>(writer_queue_cap);
    let (output_tx, output_rx) = mpsc::channel::<Frame>(writer_queue_cap);
    let writer_task = tokio::spawn(connection_writer(write_half, writer_rx, output_rx));
    let (input_tx, mut input_rx) = mpsc::channel::<InputFrame>(INPUT_QUEUE_CAPACITY);
    let input_registry = Arc::clone(&registry);
    let input_task = tokio::spawn(async move {
        while let Some(inp) = input_rx.recv().await {
            match input_registry.get(inp.session_id) {
                Some(session) => {
                    if let Err(error) = session.write_stdin(&inp.data) {
                        warn!(session_id = %inp.session_id, %error, "write_stdin failed");
                    }
                }
                None => debug!(session_id = %inp.session_id, "input_binary for unknown session; ignoring"),
            }
        }
    });

    // Drain async lifecycle events into this connection's writer queue.
    // Started here (not inside `accept_loop`) so the receiver was already
    // attached at accept time — between accept and this spawn, events go
    // into the broadcast buffer rather than being lost.
    let event_writer_tx = writer_tx.clone();
    let event_task = tokio::spawn(forward_events(event_rx, event_writer_tx));

    // session_id -> handle of the per-session forwarder task. `unsubscribe`
    // aborts the entry; closing the connection aborts all entries below.
    let mut subs: HashMap<Uuid, JoinHandle<()>> = HashMap::new();

    loop {
        tokio::select! {
            biased;
            res = shutdown.changed() => {
                if res.is_err() || *shutdown.borrow() {
                    debug!("broker connection draining due to shutdown");
                    break;
                }
            }
            frame = read_frame_async(&mut read_half) => match frame {
                Ok(frame) => {
                    if !dispatch_frame(
                        frame,
                        router.as_ref(),
                        &registry,
                        &writer_tx,
                        &output_tx,
                        &input_tx,
                        &mut subs,
                    )
                    .await
                    {
                        // Writer queue closed (peer gone); stop the read loop.
                        break;
                    }
                }
                Err(CodecError::Io(e))
                    if matches!(
                        e.kind(),
                        io::ErrorKind::UnexpectedEof
                            | io::ErrorKind::ConnectionReset
                            | io::ErrorKind::BrokenPipe
                    ) =>
                {
                    debug!(error = %e, "broker connection closed by peer");
                    break;
                }
                Err(e) => {
                    warn!(error = %e, "broker connection error; dropping connection");
                    break;
                }
            },
        }
    }

    // Cleanly tear down per-session forwarders, then the event forwarder,
    // then drop both senders so the writer task observes EOF and exits.
    for (_, h) in subs.drain() {
        h.abort();
    }
    event_task.abort();
    drop(input_tx);
    if let Err(error) = input_task.await {
        if !error.is_cancelled() { warn!(%error, "broker input task join error"); }
    }
    drop(writer_tx);
    drop(output_tx);
    if let Err(e) = writer_task.await {
        if !e.is_cancelled() {
            warn!(error = %e, "broker writer task join error");
        }
    }
}

/// Drain the per-connection event receiver into the writer queue. Logs
/// and continues on lag (events are best-effort by protocol contract);
/// returns when the broadcast channel closes or the writer queue dies.
async fn forward_events(mut rx: broadcast::Receiver<Event>, writer_tx: mpsc::Sender<Frame>) {
    loop {
        match rx.recv().await {
            Ok(ev) => {
                if writer_tx.send(Frame::Event(ev)).await.is_err() {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!(
                    lagged = n,
                    "event forwarder lagged broadcast; dropped events on this connection"
                );
            }
        }
    }
}

async fn connection_writer(
    mut w: tokio::net::unix::OwnedWriteHalf,
    mut control_rx: mpsc::Receiver<Frame>,
    mut output_rx: mpsc::Receiver<Frame>,
) {
    loop {
        let frame = tokio::select! {
            biased;
            Some(frame) = control_rx.recv() => frame,
            Some(frame) = output_rx.recv() => frame,
            else => return,
        };
        if let Err(e) = write_frame_async(&mut w, &frame).await {
            warn!(error = %e, "broker writer failed; closing connection");
            return;
        }
    }
}

/// Returns `false` if the writer queue is closed (peer gone), so the
/// caller can stop the read loop instead of looping on dead writes.
async fn dispatch_frame(
    frame: Frame,
    router: &dyn Router,
    registry: &Arc<Registry>,
    writer_tx: &mpsc::Sender<Frame>,
    output_tx: &mpsc::Sender<Frame>,
    input_tx: &mpsc::Sender<InputFrame>,
    subs: &mut HashMap<Uuid, JoinHandle<()>>,
) -> bool {
    match frame {
        Frame::ControlRequest(req) => match req.method.as_str() {
            methods::SNAPSHOT_SUBSCRIBE => handle_snapshot_subscribe(req, registry, writer_tx, output_tx, subs).await,
            methods::SUBSCRIBE => handle_subscribe(req, registry, writer_tx, output_tx, subs).await,
            methods::UNSUBSCRIBE => handle_unsubscribe(req, writer_tx, subs).await,
            _ => {
                let resp = router.handle(req);
                writer_tx.send(Frame::ControlResponse(resp)).await.is_ok()
            }
        },
        Frame::InputBinary(inp) => input_tx.send(inp).await.is_ok(),
        Frame::ControlResponse(_) | Frame::OutputBinary(_) | Frame::Event(_) => {
            // Spec: these flow broker→client only. Receiving one from a client
            // is a protocol violation. Match the symmetric TS-side behavior
            // (`src/broker/client.ts` drops the connection on the inverse case)
            // by signalling the read loop to tear down — reconnect can recover.
            warn!("broker received outbound-only frame from client; dropping connection");
            false
        }
    }
}

/// Atomically snapshot terminal state and establish the connection-local
/// replay/live subscription before releasing the terminal ordering lock.
async fn handle_snapshot_subscribe(
    req: ControlRequest,
    registry: &Arc<Registry>,
    writer_tx: &mpsc::Sender<Frame>,
    output_tx: &mpsc::Sender<Frame>,
    subs: &mut HashMap<Uuid, JoinHandle<()>>,
) -> bool {
    let id = req.id;
    let params: SnapshotParams = match req.parse_params() {
        Ok(params) => params,
        Err(error) => {
            return send_response(writer_tx, ControlResponse::err(id, ProtocolError {
                code: ErrorCode::InvalidRequest,
                message: format!("snapshot_subscribe params: {error}"),
            })).await;
        }
    };
    if params.target_cols.is_some_and(|cols| !(20..=300).contains(&cols)) {
        return send_response(writer_tx, ControlResponse::err(id, ProtocolError {
            code: ErrorCode::InvalidRequest,
            message: "snapshot_subscribe target_cols must be between 20 and 300".into(),
        })).await;
    }
    let session = match registry.get(params.session_id) {
        Some(session) => session,
        None => return send_response(writer_tx, unknown_session(id, params.session_id)).await,
    };
    let (snapshot, sub) = match session.snapshot_and_subscribe(params.scrollback_lines, params.target_cols) {
        Ok(result) => result,
        Err(error) => {
            return send_response(writer_tx, ControlResponse::err(id, ProtocolError {
                code: ErrorCode::InternalError,
                message: format!("terminal snapshot failed: {error}"),
            })).await;
        }
    };
    if let Some(previous) = subs.remove(&params.session_id) {
        previous.abort();
    }
    if !send_response(writer_tx, ControlResponse::ok(id, ResponsePayload::SnapshotSubscribe {
        snapshot,
        current_seq: sub.current_seq,
        replay_truncated: sub.replay_truncated,
    })).await {
        return false;
    }
    let session_id = params.session_id;
    let handle = tokio::spawn(forward_output(
        session_id,
        sub.replay,
        sub.receiver,
        output_tx.clone(),
    ));
    subs.insert(session_id, handle);
    true
}

/// Subscribe to a session's live output. The protocol contract is:
///   1. respond with `current_seq` so the client knows the seq watermark
///      at attach time;
///   2. AFTER the response, deliver replay frames (chunks already in the
///      ring whose seq > since_seq);
///   3. then live `output_binary` frames as the drainer publishes them.
///
/// The forwarder task below is spawned only after the response enters the
/// prioritised control queue, so it reaches the socket before replay/live
/// frames from the separate output queue.
async fn handle_subscribe(
    req: ControlRequest,
    registry: &Arc<Registry>,
    writer_tx: &mpsc::Sender<Frame>,
    output_tx: &mpsc::Sender<Frame>,
    subs: &mut HashMap<Uuid, JoinHandle<()>>,
) -> bool {
    let id = req.id;
    let params: SubscribeParams = match req.parse_params() {
        Ok(p) => p,
        Err(e) => {
            return send_response(
                writer_tx,
                ControlResponse::err(
                    id,
                    ProtocolError {
                        code: ErrorCode::InvalidRequest,
                        message: format!("subscribe params: {e}"),
                    },
                ),
            )
            .await;
        }
    };
    let session = match registry.get(params.session_id) {
        Some(s) => s,
        None => {
            return send_response(writer_tx, unknown_session(id, params.session_id)).await;
        }
    };

    let bus = session.output_bus();
    let sub = match bus.subscribe(params.since_seq) {
        Some(s) => s,
        None => {
            // Drainer already exited (PTY EOF). Surface this as
            // session_not_alive — no live bytes will ever arrive.
            return send_response(
                writer_tx,
                ControlResponse::err(
                    id,
                    ProtocolError {
                        code: ErrorCode::SessionNotAlive,
                        message: format!("session {} has no live output stream", params.session_id),
                    },
                ),
            )
            .await;
        }
    };

    // Re-subscribe is idempotent: drop the old forwarder so we don't
    // double-deliver bytes from two parallel attaches on one connection.
    if let Some(prev) = subs.remove(&params.session_id) {
        prev.abort();
    }

    if !send_response(
        writer_tx,
        ControlResponse::ok(
            id,
            ResponsePayload::Subscribe {
                ok: true,
                current_seq: sub.current_seq,
                replay_truncated: sub.replay_truncated,
            },
        ),
    )
    .await
    {
        return false;
    }

    let session_id = params.session_id;
    let handle = tokio::spawn(forward_output(
        session_id,
        sub.replay,
        sub.receiver,
        output_tx.clone(),
    ));
    subs.insert(session_id, handle);
    true
}

async fn handle_unsubscribe(
    req: ControlRequest,
    writer_tx: &mpsc::Sender<Frame>,
    subs: &mut HashMap<Uuid, JoinHandle<()>>,
) -> bool {
    let id = req.id;
    let params: UnsubscribeParams = match req.parse_params() {
        Ok(p) => p,
        Err(e) => {
            return send_response(
                writer_tx,
                ControlResponse::err(
                    id,
                    ProtocolError {
                        code: ErrorCode::InvalidRequest,
                        message: format!("unsubscribe params: {e}"),
                    },
                ),
            )
            .await;
        }
    };

    // Idempotent: dropping a non-existent subscription is `ok: true`.
    // The protocol notes that frames already in flight may still arrive;
    // aborting the forwarder here drops any not-yet-queued bytes from
    // future broadcasts.
    if let Some(prev) = subs.remove(&params.session_id) {
        prev.abort();
    }

    send_response(
        writer_tx,
        ControlResponse::ok(id, ResponsePayload::Unsubscribe { ok: true }),
    )
    .await
}

/// Queue one PTY read, merging contiguous seqs into a bounded socket frame.
fn enqueue_output_chunk(
    pending: &mut VecDeque<OutputFrame>,
    pending_bytes: &mut usize,
    session_id: Uuid,
    chunk: OutputChunk,
) {
    *pending_bytes += chunk.data.len();
    if let Some(last) = pending.back_mut() {
        if last.seq.checked_add(1) == Some(chunk.seq)
            && last.data.len() + chunk.data.len() <= OUTPUT_FRAME_COALESCE_MAX_BYTES
        {
            last.seq = chunk.seq;
            last.data.extend_from_slice(&chunk.data);
            return;
        }
    }
    pending.push_back(chunk_to_frame(session_id, chunk));
}

async fn notify_subscription_lag(output_tx: &mpsc::Sender<Frame>, session_id: Uuid, lagged: u64) {
    warn!(
        %session_id,
        lagged,
        "subscription forwarder lagged broadcast; notifying client to re-subscribe"
    );
    // This event is an output-stream barrier: queue it behind every output
    // frame already accepted for the connection. The client can then resume
    // from its last delivered seq without older frames arriving afterward.
    let _ = output_tx
        .send(Frame::Event(crate::protocol::Event::SubscriptionDropped {
            session_id,
            lagged,
        }))
        .await;
}

/// One forwarder task per (connection, session) subscription. Replay and live
/// chunks share a bounded local queue. Crucially, this task continues draining
/// the broadcast receiver while the per-connection writer is backpressured;
/// otherwise 256 tiny PTY reads can overflow the broadcast channel before the
/// Unix socket drains, forcing a replay-truncated reconnect loop.
async fn forward_output(
    session_id: Uuid,
    replay: Vec<OutputChunk>,
    mut rx: tokio::sync::broadcast::Receiver<OutputChunk>,
    output_tx: mpsc::Sender<Frame>,
) {
    let mut pending = VecDeque::new();
    let mut pending_bytes = 0;
    for chunk in replay {
        enqueue_output_chunk(&mut pending, &mut pending_bytes, session_id, chunk);
    }
    let mut receiver_closed = false;

    loop {
        if pending.is_empty() {
            if receiver_closed {
                return;
            }
            match rx.recv().await {
                Ok(chunk) => {
                    enqueue_output_chunk(&mut pending, &mut pending_bytes, session_id, chunk);
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    notify_subscription_lag(&output_tx, session_id, n).await;
                    return;
                }
            }
        }

        // Once the local byte cap is reached, apply backpressure by draining a
        // coalesced frame before accepting more. If the producer remains too
        // fast, the broadcast channel surfaces an exact Lagged count as before.
        if receiver_closed || pending_bytes >= OUTPUT_FORWARD_BUFFER_MAX_BYTES {
            let Some(frame) = pending.pop_front() else {
                continue;
            };
            pending_bytes -= frame.data.len();
            if output_tx.send(Frame::OutputBinary(frame)).await.is_err() {
                return;
            }
            continue;
        }

        tokio::select! {
            received = rx.recv() => match received {
                Ok(chunk) => {
                    enqueue_output_chunk(&mut pending, &mut pending_bytes, session_id, chunk);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    receiver_closed = true;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    notify_subscription_lag(&output_tx, session_id, n).await;
                    return;
                }
            },
            permit = output_tx.reserve() => {
                let Ok(permit) = permit else {
                    return;
                };
                let Some(frame) = pending.pop_front() else {
                    continue;
                };
                pending_bytes -= frame.data.len();
                permit.send(Frame::OutputBinary(frame));
            }
        }
    }
}

fn chunk_to_frame(session_id: Uuid, chunk: OutputChunk) -> OutputFrame {
    // The ring stores `Arc<Vec<u8>>` to share between live + replay; the
    // codec frame owns its bytes, so we materialise here. With one
    // outstanding subscriber per session this is just a take; with
    // multiple subscribers each pays the clone cost separately, which is
    // an explicit tradeoff for not coupling subscribers to each other.
    OutputFrame {
        session_id,
        seq: chunk.seq,
        data: chunk.data.as_ref().clone(),
    }
}

async fn send_response(writer_tx: &mpsc::Sender<Frame>, resp: ControlResponse) -> bool {
    writer_tx.send(Frame::ControlResponse(resp)).await.is_ok()
}

fn unknown_session(id: u64, session_id: Uuid) -> ControlResponse {
    ControlResponse::err(
        id,
        ProtocolError {
            code: ErrorCode::UnknownSession,
            message: format!("unknown session: {session_id}"),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slow_output_forwarder_preserves_burst_during_writer_backpressure() {
        const CHUNK_COUNT: u64 = 2_000;
        let session_id = Uuid::new_v4();
        let bus = crate::output_bus::OutputBus::new(CHUNK_COUNT as usize, 256);
        let subscription = bus.subscribe(None).expect("subscribe");
        let (output_tx, mut output_rx) = mpsc::channel(1);

        output_tx
            .send(Frame::Event(Event::SnapshotInvalidated {
                session_id: Uuid::nil(),
            }))
            .await
            .expect("fill writer queue");

        let forwarder = tokio::spawn(forward_output(
            session_id,
            subscription.replay,
            subscription.receiver,
            output_tx,
        ));
        tokio::task::yield_now().await;

        for seq in 1..=CHUNK_COUNT {
            bus.publish(OutputChunk {
                seq,
                data: Arc::new(vec![b'x']),
            });
            tokio::task::yield_now().await;
        }
        bus.close();

        assert!(matches!(
            output_rx.recv().await,
            Some(Frame::Event(Event::SnapshotInvalidated { .. }))
        ));

        let mut output = Vec::new();
        let mut output_seqs = Vec::new();
        while output.len() < CHUNK_COUNT as usize {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(1), output_rx.recv())
                .await
                .expect("forwarder response timeout")
                .expect("writer queue closed");
            match frame {
                Frame::OutputBinary(frame) => {
                    output.extend_from_slice(&frame.data);
                    output_seqs.push(frame.seq);
                }
                Frame::Event(Event::SubscriptionDropped { lagged, .. }) => {
                    panic!("buffered redraw burst was dropped: {lagged} chunks");
                }
                _ => {}
            }
        }

        assert_eq!(output, vec![b'x'; CHUNK_COUNT as usize]);
        assert_eq!(output_seqs, [CHUNK_COUNT]);
        tokio::time::timeout(std::time::Duration::from_secs(1), forwarder)
            .await
            .expect("forwarder did not stop after bus close")
            .expect("forwarder task failed");
    }

    #[tokio::test]
    async fn replay_precedes_live_output_when_coalesced_under_backpressure() {
        let session_id = Uuid::new_v4();
        let bus = crate::output_bus::OutputBus::new(8, 8);
        for (seq, byte) in [(1, b'a'), (2, b'b')] {
            bus.publish(OutputChunk {
                seq,
                data: Arc::new(vec![byte]),
            });
        }
        let subscription = bus.subscribe(Some(0)).expect("subscribe");
        let (output_tx, mut output_rx) = mpsc::channel(1);
        output_tx
            .send(Frame::Event(Event::SnapshotInvalidated {
                session_id: Uuid::nil(),
            }))
            .await
            .expect("fill output queue");

        let forwarder = tokio::spawn(forward_output(
            session_id,
            subscription.replay,
            subscription.receiver,
            output_tx,
        ));
        for (seq, byte) in [(3, b'c'), (4, b'd')] {
            bus.publish(OutputChunk {
                seq,
                data: Arc::new(vec![byte]),
            });
        }
        bus.close();

        assert!(matches!(
            output_rx.recv().await,
            Some(Frame::Event(Event::SnapshotInvalidated { .. }))
        ));
        let mut output = Vec::new();
        let mut output_seqs = Vec::new();
        while output.len() < 4 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(1), output_rx.recv())
                .await
                .expect("coalesced replay/live output timeout")
                .expect("output queue closed");
            if let Frame::OutputBinary(frame) = frame {
                output.extend_from_slice(&frame.data);
                output_seqs.push(frame.seq);
            }
        }
        assert_eq!(output, b"abcd");
        assert!(output_seqs.windows(2).all(|seqs| seqs[0] < seqs[1]));
        assert_eq!(output_seqs.last(), Some(&4));
        tokio::time::timeout(std::time::Duration::from_secs(1), forwarder)
            .await
            .expect("forwarder did not stop after bus close")
            .expect("forwarder task failed");
    }

    #[tokio::test]
    async fn sustained_output_beyond_local_cap_uses_lag_recovery() {
        const CHUNK_BYTES: usize = 8 * 1024;
        const CHUNKS_TO_CAP: u64 = (OUTPUT_FORWARD_BUFFER_MAX_BYTES / CHUNK_BYTES) as u64;
        let session_id = Uuid::new_v4();
        let bus = crate::output_bus::OutputBus::new(64, 64);
        let subscription = bus.subscribe(None).expect("subscribe");
        let (output_tx, mut output_rx) = mpsc::channel(1);
        output_tx
            .send(Frame::Event(Event::SnapshotInvalidated {
                session_id: Uuid::nil(),
            }))
            .await
            .expect("fill output queue");

        let forwarder = tokio::spawn(forward_output(
            session_id,
            subscription.replay,
            subscription.receiver,
            output_tx,
        ));
        for seq in 1..=CHUNKS_TO_CAP {
            bus.publish(OutputChunk {
                seq,
                data: Arc::new(vec![b'x'; CHUNK_BYTES]),
            });
            tokio::task::yield_now().await;
        }
        for seq in (CHUNKS_TO_CAP + 1)..=(CHUNKS_TO_CAP + 128) {
            bus.publish(OutputChunk {
                seq,
                data: Arc::new(vec![b'y'; CHUNK_BYTES]),
            });
        }

        assert!(matches!(
            output_rx.recv().await,
            Some(Frame::Event(Event::SnapshotInvalidated { .. }))
        ));
        assert!(matches!(
            output_rx.recv().await,
            Some(Frame::OutputBinary(OutputFrame { seq: 1, .. }))
        ));
        let event = tokio::time::timeout(std::time::Duration::from_millis(100), output_rx.recv())
            .await
            .expect("SubscriptionDropped overtook older queued output")
            .expect("output queue closed");
        assert!(matches!(
            event,
            Frame::Event(Event::SubscriptionDropped {
                session_id: dropped_session,
                lagged,
            }) if dropped_session == session_id && lagged > 0
        ));
        tokio::time::timeout(std::time::Duration::from_secs(1), forwarder)
            .await
            .expect("forwarder did not stop after lag recovery")
            .expect("forwarder task failed");
    }

    #[tokio::test]
    async fn connection_writer_sends_control_before_queued_output() {
        let session_id = Uuid::new_v4();
        let (broker_stream, mut client_stream) = UnixStream::pair().expect("socket pair");
        let (_read_half, write_half) = broker_stream.into_split();
        let (control_tx, control_rx) = mpsc::channel(1);
        let (output_tx, output_rx) = mpsc::channel(1);
        output_tx
            .send(Frame::OutputBinary(OutputFrame {
                session_id,
                seq: 1,
                data: vec![b'x'],
            }))
            .await
            .expect("queue output");
        control_tx
            .send(Frame::ControlResponse(unknown_session(7, Uuid::nil())))
            .await
            .expect("queue control response");
        drop(control_tx);
        drop(output_tx);

        let writer = tokio::spawn(connection_writer(write_half, control_rx, output_rx));
        assert!(matches!(
            read_frame_async(&mut client_stream)
                .await
                .expect("read control response"),
            Frame::ControlResponse(ControlResponse { id: 7, .. })
        ));
        assert!(matches!(
            read_frame_async(&mut client_stream).await.expect("read output"),
            Frame::OutputBinary(OutputFrame {
                session_id: output_session,
                seq: 1,
                ..
            }) if output_session == session_id
        ));
        writer.await.expect("writer task failed");
    }

    #[tokio::test]
    async fn output_burst_leaves_writer_capacity_for_control_response() {
        const OUTPUT_CHUNKS: u64 = 400;
        let session_id = Uuid::new_v4();
        let bus = crate::output_bus::OutputBus::new(512, 512);
        let subscription = bus.subscribe(None).expect("subscribe");
        let (output_tx, _output_rx) = mpsc::channel(18);
        let (control_tx, mut control_rx) = mpsc::channel(18);

        let forwarder = tokio::spawn(forward_output(
            session_id,
            subscription.replay,
            subscription.receiver,
            output_tx,
        ));
        for seq in 1..=OUTPUT_CHUNKS {
            bus.publish(OutputChunk {
                seq,
                data: Arc::new(vec![b'x'; 8 * 1024]),
            });
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }

        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            control_tx.send(Frame::ControlResponse(unknown_session(7, Uuid::nil()))),
        )
        .await
        .expect("output saturated the writer queue and starved a control response")
        .expect("control queue closed");
        assert!(matches!(
            control_rx.recv().await,
            Some(Frame::ControlResponse(ControlResponse { id: 7, .. }))
        ));

        forwarder.abort();
    }

    #[test]
    fn default_socket_path_uses_xdg_runtime_dir() {
        // Avoid mutating global env mid-test; just verify the function picks up
        // the runtime dir when set.
        let path = if let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR") {
            let mut p = PathBuf::from(rt);
            p.push("wolfpack-broker.sock");
            p
        } else {
            let mut p = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            p.push(".wolfpack");
            p.push("broker.sock");
            p
        };
        assert_eq!(default_socket_path(), path);
    }
}

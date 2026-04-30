use std::collections::HashMap;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::codec::{
    read_frame_async, write_frame_async, CodecError, Frame, OutputFrame,
};
use crate::protocol::{
    methods, ControlRequest, ControlResponse, ErrorCode, Event, ProtocolError, ResponsePayload,
    SubscribeParams, UnsubscribeParams,
};
use crate::registry::Registry;
use crate::ring_buffer::OutputChunk;
use crate::router::Router;
use crate::session::EventSender;

/// Per-connection writer queue depth. Backpressure: if the writer falls
/// behind by more than this many frames, the broadcast forwarder will
/// block until the socket drains. The PTY itself is never blocked because
/// it publishes through the broadcast channel; only this connection's
/// fanout slows down.
const WRITER_QUEUE_CAPACITY: usize = 1024;

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
    /// Override the per-connection writer queue depth. `None` → use the
    /// production default (1024). Only set this in tests that need a small
    /// queue to trigger backpressure quickly.
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
            let _ = std::fs::set_permissions(
                parent,
                std::fs::Permissions::from_mode(0o700),
            );
        }
    }
    // Stale socket files from a previous broker process must be removed before
    // bind() can succeed. Ignore-not-found is intentional.
    let _ = std::fs::remove_file(&socket_path);

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

    // Per-connection writer mpsc + dedicated writer task. Every outbound
    // frame on this connection — control responses, output_binary live
    // chunks, events — funnels through this queue so writes are
    // serialised on the socket and ordering is preserved.
    let (writer_tx, writer_rx) = mpsc::channel::<Frame>(writer_queue_cap);
    let writer_task = tokio::spawn(connection_writer(write_half, writer_rx));

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
    // then drop the writer sender so the writer task observes EOF and exits.
    for (_, h) in subs.drain() {
        h.abort();
    }
    event_task.abort();
    drop(writer_tx);
    if let Err(e) = writer_task.await {
        if !e.is_cancelled() {
            warn!(error = %e, "broker writer task join error");
        }
    }
}

/// Drain the per-connection event receiver into the writer queue. Logs
/// and continues on lag (events are best-effort by protocol contract);
/// returns when the broadcast channel closes or the writer queue dies.
async fn forward_events(
    mut rx: broadcast::Receiver<Event>,
    writer_tx: mpsc::Sender<Frame>,
) {
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
    mut rx: mpsc::Receiver<Frame>,
) {
    while let Some(frame) = rx.recv().await {
        if let Err(e) = write_frame_async(&mut w, &frame).await {
            warn!(error = %e, "broker writer failed; closing connection");
            break;
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
    subs: &mut HashMap<Uuid, JoinHandle<()>>,
) -> bool {
    match frame {
        Frame::ControlRequest(req) => match req.method.as_str() {
            methods::SUBSCRIBE => handle_subscribe(req, registry, writer_tx, subs).await,
            methods::UNSUBSCRIBE => handle_unsubscribe(req, writer_tx, subs).await,
            _ => {
                let resp = router.handle(req);
                writer_tx
                    .send(Frame::ControlResponse(resp))
                    .await
                    .is_ok()
            }
        },
        Frame::InputBinary(inp) => {
            match registry.get(inp.session_id) {
                Some(session) => {
                    if let Err(e) = session.write_stdin(&inp.data) {
                        warn!(session_id = %inp.session_id, error = %e, "write_stdin failed");
                    }
                }
                None => {
                    debug!(session_id = %inp.session_id, "input_binary for unknown session; ignoring");
                }
            }
            true
        }
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

/// Subscribe to a session's live output. The protocol contract is:
///   1. respond with `current_seq` so the client knows the seq watermark
///      at attach time;
///   2. AFTER the response, deliver replay frames (chunks already in the
///      ring whose seq > since_seq);
///   3. then live `output_binary` frames as the drainer publishes them.
///
/// The forwarder task below is spawned only after the response is queued
/// so the writer mpsc preserves the (response, replay, live...) order.
async fn handle_subscribe(
    req: ControlRequest,
    registry: &Arc<Registry>,
    writer_tx: &mpsc::Sender<Frame>,
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
                        message: format!(
                            "session {} has no live output stream",
                            params.session_id
                        ),
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
    let writer_clone = writer_tx.clone();
    let handle = tokio::spawn(forward_output(
        session_id,
        sub.replay,
        sub.receiver,
        writer_clone,
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

/// One forwarder task per (connection, session) subscription. Pushes
/// replay first (chunks the ring still held at subscribe time), then
/// pulls from the broadcast receiver until the bus closes or the writer
/// queue dies. On `RecvError::Lagged(_)`, the forwarder logs and stops:
/// the client must re-`subscribe` (or `snapshot`) to recover. Surfacing
/// lag rather than silently swallowing it preserves the seq invariant.
async fn forward_output(
    session_id: Uuid,
    replay: Vec<OutputChunk>,
    mut rx: tokio::sync::broadcast::Receiver<OutputChunk>,
    writer_tx: mpsc::Sender<Frame>,
) {
    for chunk in replay {
        if writer_tx
            .send(Frame::OutputBinary(chunk_to_frame(session_id, chunk)))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        match rx.recv().await {
            Ok(chunk) => {
                if writer_tx
                    .send(Frame::OutputBinary(chunk_to_frame(session_id, chunk)))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                warn!(
                    %session_id,
                    lagged = n,
                    "subscription forwarder lagged broadcast; notifying client to re-subscribe"
                );
                // Notify the client directly on its writer channel so it can
                // re-snapshot and re-subscribe. This event is NOT broadcast to
                // all clients — only this connection's writer sees it.
                let _ = writer_tx
                    .send(Frame::Event(crate::protocol::Event::SubscriptionDropped {
                        session_id,
                        lagged: n,
                    }))
                    .await;
                return;
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
    writer_tx
        .send(Frame::ControlResponse(resp))
        .await
        .is_ok()
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

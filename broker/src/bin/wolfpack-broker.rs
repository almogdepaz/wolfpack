use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::broadcast;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use wolfpack_broker::protocol::Event;
use wolfpack_broker::registry::{spawn_exit_reaper, Registry};
use wolfpack_broker::server::{default_socket_path, start, ServerConfig};
use wolfpack_broker::session_router::{SessionRouter, EVENT_BUS_CAPACITY};

#[tokio::main]
async fn main() {
    init_logging();

    let socket_path = std::env::var_os("WOLFPACK_BROKER_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(default_socket_path);

    info!(
        version = env!("CARGO_PKG_VERSION"),
        protocol = wolfpack_broker::protocol::PROTOCOL_VERSION,
        socket = %socket_path.display(),
        "wolfpack-broker starting"
    );

    let (events, _) = broadcast::channel::<Event>(EVENT_BUS_CAPACITY);
    let registry = Arc::new(Registry::new(events.clone()));
    spawn_exit_reaper(&registry);
    let server = match start(ServerConfig {
        socket_path: socket_path.clone(),
        router: Arc::new(SessionRouter::new(Arc::clone(&registry), events.clone())),
        registry: Arc::clone(&registry),
        events,
        writer_queue_capacity: None,
    })
    .await
    {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "broker failed to start");
            if let Some(explanation) = srt_unix_socket_bind_explanation(&socket_path, &e) {
                eprintln!("{explanation}");
            }
            std::process::exit(1);
        }
    };

    wait_for_signal().await;
    info!("broker shutdown initiated");
    server.shutdown().await;
    info!("broker shutdown complete");
}

fn init_logging() {
    let filter =
        EnvFilter::try_from_env("WOLFPACK_BROKER_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

fn srt_unix_socket_bind_explanation(socket_path: &Path, error: &io::Error) -> Option<String> {
    srt_unix_socket_bind_explanation_for(
        std::env::var_os("SANDBOX_RUNTIME").is_some(),
        socket_path,
        error,
    )
}

fn srt_unix_socket_bind_explanation_for(
    sandbox_runtime: bool,
    socket_path: &Path,
    error: &io::Error,
) -> Option<String> {
    if !sandbox_runtime || error.kind() != io::ErrorKind::PermissionDenied {
        return None;
    }

    let parent = socket_path
        .parent()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| ".".to_string());

    Some(format!(
        "wolfpack-broker cannot start inside srt: default srt blocks Unix domain socket bind/listen. socket: {}. Run broker startup/perf tests outside srt, use a host broker and let sandboxed clients connect to it, or use a dedicated srt settings file with network.allowUnixSockets including this socket path and filesystem.allowWrite including its parent directory ({}). Do not enable allowAllUnixSockets for default Ralph runs.",
        socket_path.display(),
        parent,
    ))
}

async fn wait_for_signal() {
    let mut term = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "failed to install SIGTERM handler");
            return;
        }
    };
    let mut intr = match signal(SignalKind::interrupt()) {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "failed to install SIGINT handler");
            return;
        }
    };
    tokio::select! {
        _ = term.recv() => info!("received SIGTERM"),
        _ = intr.recv() => info!("received SIGINT"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_srt_permission_denied_on_unix_socket_bind() {
        let err = io::Error::from(io::ErrorKind::PermissionDenied);
        let message = srt_unix_socket_bind_explanation_for(
            true,
            Path::new("/tmp/wolfpack-broker.sock"),
            &err,
        )
        .expect("expected srt bind explanation");

        assert!(message.contains("cannot start inside srt"));
        assert!(message.contains("Unix domain socket bind/listen"));
        assert!(message.contains("network.allowUnixSockets"));
        assert!(message.contains("filesystem.allowWrite"));
        assert!(message.contains("/tmp"));
    }

    #[test]
    fn does_not_explain_non_srt_permission_denied() {
        let err = io::Error::from(io::ErrorKind::PermissionDenied);
        assert!(srt_unix_socket_bind_explanation_for(
            false,
            Path::new("/tmp/wolfpack-broker.sock"),
            &err,
        )
        .is_none());
    }

    #[test]
    fn does_not_explain_other_start_errors() {
        let err = io::Error::from(io::ErrorKind::AddrInUse);
        assert!(srt_unix_socket_bind_explanation_for(
            true,
            Path::new("/tmp/wolfpack-broker.sock"),
            &err,
        )
        .is_none());
    }
}

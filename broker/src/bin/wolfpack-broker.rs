use std::path::PathBuf;
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
        socket_path,
        router: Arc::new(SessionRouter::new(Arc::clone(&registry), events.clone())),
        registry: Arc::clone(&registry),
        events,
    })
    .await
    {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "broker failed to start");
            std::process::exit(1);
        }
    };

    wait_for_signal().await;
    info!("broker shutdown initiated");
    server.shutdown().await;
    info!("broker shutdown complete");
}

fn init_logging() {
    let filter = EnvFilter::try_from_env("WOLFPACK_BROKER_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
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

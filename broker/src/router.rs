use crate::protocol::{ControlRequest, ControlResponse};

/// Routes a `ControlRequest` to a `ControlResponse`. Implemented by
/// [`crate::session_router::SessionRouter`] in production.
pub trait Router: Send + Sync + 'static {
    fn handle(&self, req: ControlRequest) -> ControlResponse;
}

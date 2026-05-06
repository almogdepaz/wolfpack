use crate::protocol::{ControlRequest, ControlResponse};

/// Routes a `ControlRequest` to a `ControlResponse`. Implemented by
/// [`crate::session_router::SessionRouter`] in production and by `StubRouter`
/// in transport-only unit tests.
pub trait Router: Send + Sync + 'static {
    fn handle(&self, req: ControlRequest) -> ControlResponse;
}

#[cfg(test)]
use crate::protocol::{
    methods, ErrorCode, ListSessionsParams, ProtocolError, ResponsePayload,
};

/// Test-only router that exercises framing + dispatch without any session
/// state. Implements `list_sessions` (always empty), reports every other known
/// method as `unsupported`, and emits `unknown_method` for anything else.
#[cfg(test)]
#[derive(Debug, Default, Clone, Copy)]
pub struct StubRouter;

#[cfg(test)]
impl Router for StubRouter {
    fn handle(&self, req: ControlRequest) -> ControlResponse {
        let id = req.id;
        match req.method.as_str() {
            methods::LIST_SESSIONS => match req.parse_params::<ListSessionsParams>() {
                Ok(_) => ControlResponse::ok(
                    id,
                    ResponsePayload::ListSessions { sessions: vec![] },
                ),
                Err(e) => invalid_request(id, format!("list_sessions params: {e}")),
            },
            methods::CREATE_SESSION
            | methods::KILL_SESSION
            | methods::SESSION_INFO
            | methods::SNAPSHOT
            | methods::RESIZE
            | methods::SUBSCRIBE
            | methods::UNSUBSCRIBE => unsupported(id, &req.method),
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

#[cfg(test)]
fn invalid_request(id: u64, msg: impl Into<String>) -> ControlResponse {
    ControlResponse::err(
        id,
        ProtocolError {
            code: ErrorCode::InvalidRequest,
            message: msg.into(),
        },
    )
}

#[cfg(test)]
fn unsupported(id: u64, method: &str) -> ControlResponse {
    ControlResponse::err(
        id,
        ProtocolError {
            code: ErrorCode::Unsupported,
            message: format!("method {method} not implemented in test stub router"),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Status;
    use serde_json::json;

    fn req(id: u64, method: &str, params: serde_json::Value) -> ControlRequest {
        ControlRequest {
            id,
            method: method.into(),
            params,
        }
    }

    #[test]
    fn list_sessions_returns_empty_list() {
        let resp = StubRouter.handle(req(7, methods::LIST_SESSIONS, json!({})));
        assert_eq!(resp.id, 7);
        assert_eq!(resp.status, Status::Ok);
        match resp.payload.expect("payload") {
            ResponsePayload::ListSessions { sessions } => assert!(sessions.is_empty()),
            other => panic!("unexpected payload kind: {other:?}"),
        }
        assert!(resp.error.is_none());
    }

    #[test]
    fn list_sessions_rejects_non_object_params() {
        let resp = StubRouter.handle(req(8, methods::LIST_SESSIONS, json!([1, 2, 3])));
        assert_eq!(resp.status, Status::Error);
        let err = resp.error.expect("error");
        assert_eq!(err.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn create_session_is_unsupported_in_skeleton() {
        let resp = StubRouter.handle(req(
            9,
            methods::CREATE_SESSION,
            json!({ "cwd": "/tmp", "command": ["bash"], "cols": 80, "rows": 24 }),
        ));
        assert_eq!(resp.status, Status::Error);
        let err = resp.error.expect("error");
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("create_session"));
    }

    #[test]
    fn every_session_op_is_unsupported_in_skeleton() {
        for method in [
            methods::CREATE_SESSION,
            methods::KILL_SESSION,
            methods::SESSION_INFO,
            methods::SNAPSHOT,
            methods::RESIZE,
            methods::SUBSCRIBE,
            methods::UNSUBSCRIBE,
        ] {
            let resp = StubRouter.handle(req(1, method, json!({})));
            assert_eq!(resp.status, Status::Error, "{method} should error");
            assert_eq!(
                resp.error.as_ref().unwrap().code,
                ErrorCode::Unsupported,
                "{method} should be Unsupported in skeleton"
            );
        }
    }

    #[test]
    fn unknown_method_yields_unknown_method_error() {
        let resp = StubRouter.handle(req(11, "do_a_barrel_roll", json!({})));
        assert_eq!(resp.status, Status::Error);
        let err = resp.error.expect("error");
        assert_eq!(err.code, ErrorCode::UnknownMethod);
        assert!(err.message.contains("do_a_barrel_roll"));
    }

    #[test]
    fn response_id_mirrors_request_id() {
        let resp = StubRouter.handle(req(424242, methods::LIST_SESSIONS, json!({})));
        assert_eq!(resp.id, 424242);
    }
}

use crate::protocol::{ControlRequest, ControlResponse, Event};
use std::io::{self, Read, Write};
use thiserror::Error;
use uuid::Uuid;

pub const FRAME_KIND_CONTROL_REQUEST: u8 = 0x01;
pub const FRAME_KIND_CONTROL_RESPONSE: u8 = 0x02;
pub const FRAME_KIND_OUTPUT_BINARY: u8 = 0x03;
pub const FRAME_KIND_INPUT_BINARY: u8 = 0x04;
pub const FRAME_KIND_EVENT: u8 = 0x05;

pub const MAX_FRAME_PAYLOAD: u32 = 16 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum CodecError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("frame too large: {0} bytes")]
    FrameTooLarge(u32),
    #[error("unknown frame kind: 0x{0:02x}")]
    UnknownKind(u8),
    #[error("binary frame too short")]
    ShortBinary,
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, CodecError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputFrame {
    pub session_id: Uuid,
    pub seq: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputFrame {
    pub session_id: Uuid,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    ControlRequest(ControlRequest),
    ControlResponse(ControlResponse),
    OutputBinary(OutputFrame),
    InputBinary(InputFrame),
    Event(Event),
}

pub fn write_frame<W: Write>(w: &mut W, frame: &Frame) -> Result<()> {
    let (kind, payload) = encode_payload(frame)?;
    if payload.len() > MAX_FRAME_PAYLOAD as usize {
        return Err(CodecError::FrameTooLarge(payload.len() as u32));
    }
    let len = (payload.len() as u32).to_be_bytes();
    w.write_all(&[kind])?;
    w.write_all(&len)?;
    w.write_all(&payload)?;
    Ok(())
}

pub fn read_frame<R: Read>(r: &mut R) -> Result<Frame> {
    let mut header = [0u8; 5];
    r.read_exact(&mut header)?;
    let kind = header[0];
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
    if len > MAX_FRAME_PAYLOAD {
        return Err(CodecError::FrameTooLarge(len));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    decode_payload(kind, &payload)
}

pub async fn read_frame_async<R>(r: &mut R) -> Result<Frame>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut header = [0u8; 5];
    r.read_exact(&mut header).await?;
    let kind = header[0];
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
    if len > MAX_FRAME_PAYLOAD {
        return Err(CodecError::FrameTooLarge(len));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload).await?;
    decode_payload(kind, &payload)
}

pub async fn write_frame_async<W>(w: &mut W, frame: &Frame) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    let (kind, payload) = encode_payload(frame)?;
    if payload.len() > MAX_FRAME_PAYLOAD as usize {
        return Err(CodecError::FrameTooLarge(payload.len() as u32));
    }
    let len = (payload.len() as u32).to_be_bytes();
    w.write_all(&[kind]).await?;
    w.write_all(&len).await?;
    w.write_all(&payload).await?;
    w.flush().await?;
    Ok(())
}

fn encode_payload(frame: &Frame) -> Result<(u8, Vec<u8>)> {
    Ok(match frame {
        Frame::ControlRequest(req) => (FRAME_KIND_CONTROL_REQUEST, serde_json::to_vec(req)?),
        Frame::ControlResponse(res) => (FRAME_KIND_CONTROL_RESPONSE, serde_json::to_vec(res)?),
        Frame::Event(ev) => (FRAME_KIND_EVENT, serde_json::to_vec(ev)?),
        Frame::OutputBinary(out) => {
            let mut buf = Vec::with_capacity(24 + out.data.len());
            buf.extend_from_slice(out.session_id.as_bytes());
            buf.extend_from_slice(&out.seq.to_be_bytes());
            buf.extend_from_slice(&out.data);
            (FRAME_KIND_OUTPUT_BINARY, buf)
        }
        Frame::InputBinary(inp) => {
            let mut buf = Vec::with_capacity(16 + inp.data.len());
            buf.extend_from_slice(inp.session_id.as_bytes());
            buf.extend_from_slice(&inp.data);
            (FRAME_KIND_INPUT_BINARY, buf)
        }
    })
}

fn decode_payload(kind: u8, payload: &[u8]) -> Result<Frame> {
    Ok(match kind {
        FRAME_KIND_CONTROL_REQUEST => Frame::ControlRequest(serde_json::from_slice(payload)?),
        FRAME_KIND_CONTROL_RESPONSE => Frame::ControlResponse(serde_json::from_slice(payload)?),
        FRAME_KIND_EVENT => Frame::Event(serde_json::from_slice(payload)?),
        FRAME_KIND_OUTPUT_BINARY => {
            if payload.len() < 24 {
                return Err(CodecError::ShortBinary);
            }
            let mut id = [0u8; 16];
            id.copy_from_slice(&payload[..16]);
            let mut seq = [0u8; 8];
            seq.copy_from_slice(&payload[16..24]);
            Frame::OutputBinary(OutputFrame {
                session_id: Uuid::from_bytes(id),
                seq: u64::from_be_bytes(seq),
                data: payload[24..].to_vec(),
            })
        }
        FRAME_KIND_INPUT_BINARY => {
            if payload.len() < 16 {
                return Err(CodecError::ShortBinary);
            }
            let mut id = [0u8; 16];
            id.copy_from_slice(&payload[..16]);
            Frame::InputBinary(InputFrame {
                session_id: Uuid::from_bytes(id),
                data: payload[16..].to_vec(),
            })
        }
        other => return Err(CodecError::UnknownKind(other)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{methods, ControlResponse, Event, ProtocolError, ErrorCode, ResponsePayload};
    use serde_json::json;
    use std::io::Cursor;

    fn nil() -> Uuid {
        Uuid::nil()
    }

    #[test]
    fn control_request_roundtrip() {
        let req = ControlRequest {
            id: 1,
            method: methods::LIST_SESSIONS.into(),
            params: json!({}),
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &Frame::ControlRequest(req.clone())).unwrap();
        assert_eq!(buf[0], FRAME_KIND_CONTROL_REQUEST);
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap() {
            Frame::ControlRequest(r) => assert_eq!(r, req),
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn control_response_roundtrip() {
        let resp = ControlResponse::err(
            2,
            ProtocolError { code: ErrorCode::UnknownMethod, message: "nope".into() },
        );
        let mut buf = Vec::new();
        write_frame(&mut buf, &Frame::ControlResponse(resp.clone())).unwrap();
        assert_eq!(buf[0], FRAME_KIND_CONTROL_RESPONSE);
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap() {
            Frame::ControlResponse(r) => assert_eq!(r, resp),
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn output_binary_roundtrip_preserves_id_seq_and_data() {
        let id = Uuid::from_u128(0xDEADBEEFCAFEBABE0011223344556677u128);
        let out = OutputFrame {
            session_id: id,
            seq: 0xCAFEBABE,
            data: b"hello\x1b[Hworld".to_vec(),
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &Frame::OutputBinary(out.clone())).unwrap();
        assert_eq!(buf[0], FRAME_KIND_OUTPUT_BINARY);
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap() {
            Frame::OutputBinary(b) => assert_eq!(b, out),
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn input_binary_roundtrip() {
        let inp = InputFrame { session_id: nil(), data: vec![0x03] };
        let mut buf = Vec::new();
        write_frame(&mut buf, &Frame::InputBinary(inp.clone())).unwrap();
        assert_eq!(buf[0], FRAME_KIND_INPUT_BINARY);
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap() {
            Frame::InputBinary(b) => assert_eq!(b, inp),
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn event_roundtrip() {
        let ev = Event::SessionResized { session_id: nil(), cols: 100, rows: 40 };
        let mut buf = Vec::new();
        write_frame(&mut buf, &Frame::Event(ev.clone())).unwrap();
        assert_eq!(buf[0], FRAME_KIND_EVENT);
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap() {
            Frame::Event(e) => assert_eq!(e, ev),
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_kind() {
        let buf = vec![0xFF, 0, 0, 0, 0];
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur) {
            Err(CodecError::UnknownKind(0xFF)) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn rejects_short_output_binary() {
        let mut buf = vec![FRAME_KIND_OUTPUT_BINARY, 0, 0, 0, 10];
        buf.extend_from_slice(&[0u8; 10]);
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur) {
            Err(CodecError::ShortBinary) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn rejects_short_input_binary() {
        let mut buf = vec![FRAME_KIND_INPUT_BINARY, 0, 0, 0, 5];
        buf.extend_from_slice(&[0u8; 5]);
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur) {
            Err(CodecError::ShortBinary) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn rejects_oversized_frame() {
        // length header announces 32MiB which exceeds MAX_FRAME_PAYLOAD
        let buf = vec![FRAME_KIND_INPUT_BINARY, 0x02, 0x00, 0x00, 0x00];
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur) {
            Err(CodecError::FrameTooLarge(_)) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn frames_can_be_streamed_back_to_back() {
        let req = ControlRequest {
            id: 1,
            method: methods::SUBSCRIBE.into(),
            params: json!({ "session_id": Uuid::nil() }),
        };
        let resp = ControlResponse::ok(1, ResponsePayload::Subscribe { ok: true, current_seq: 0, replay_truncated: false });
        let out = OutputFrame { session_id: nil(), seq: 1, data: b"abc".to_vec() };
        let inp = InputFrame { session_id: nil(), data: b"\r".to_vec() };
        let ev = Event::SnapshotInvalidated { session_id: nil() };

        let mut buf = Vec::new();
        write_frame(&mut buf, &Frame::ControlRequest(req.clone())).unwrap();
        write_frame(&mut buf, &Frame::ControlResponse(resp.clone())).unwrap();
        write_frame(&mut buf, &Frame::OutputBinary(out.clone())).unwrap();
        write_frame(&mut buf, &Frame::InputBinary(inp.clone())).unwrap();
        write_frame(&mut buf, &Frame::Event(ev.clone())).unwrap();

        let mut cur = Cursor::new(buf);
        assert!(matches!(read_frame(&mut cur).unwrap(), Frame::ControlRequest(r) if r == req));
        assert!(matches!(read_frame(&mut cur).unwrap(), Frame::ControlResponse(r) if r == resp));
        assert!(matches!(read_frame(&mut cur).unwrap(), Frame::OutputBinary(o) if o == out));
        assert!(matches!(read_frame(&mut cur).unwrap(), Frame::InputBinary(i) if i == inp));
        assert!(matches!(read_frame(&mut cur).unwrap(), Frame::Event(e) if e == ev));
    }
}

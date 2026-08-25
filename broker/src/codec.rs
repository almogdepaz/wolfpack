use crate::protocol::{ControlRequest, ControlResponse, Event};
use std::io::{self, IoSlice, Read, Write};
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;

pub const FRAME_KIND_CONTROL_REQUEST: u8 = 0x01;
pub const FRAME_KIND_CONTROL_RESPONSE: u8 = 0x02;
pub const FRAME_KIND_OUTPUT_BINARY: u8 = 0x03;
pub const FRAME_KIND_INPUT_BINARY: u8 = 0x04;
pub const FRAME_KIND_EVENT: u8 = 0x05;

pub const MAX_FRAME_PAYLOAD: u32 = 16 * 1024 * 1024;
pub const MAX_CONTROL_REQUEST_PAYLOAD: u32 = 1024 * 1024;
pub const MAX_CONTROL_RESPONSE_PAYLOAD: u32 = MAX_FRAME_PAYLOAD;
pub const MAX_OUTPUT_BINARY_PAYLOAD: u32 = 1024 * 1024;
pub const MAX_INPUT_BINARY_PAYLOAD: u32 = 256 * 1024;
pub const MAX_EVENT_PAYLOAD: u32 = 256 * 1024;

fn max_payload_for_kind(kind: u8) -> Option<u32> {
    match kind {
        FRAME_KIND_CONTROL_REQUEST => Some(MAX_CONTROL_REQUEST_PAYLOAD),
        FRAME_KIND_CONTROL_RESPONSE => Some(MAX_CONTROL_RESPONSE_PAYLOAD),
        FRAME_KIND_OUTPUT_BINARY => Some(MAX_OUTPUT_BINARY_PAYLOAD),
        FRAME_KIND_INPUT_BINARY => Some(MAX_INPUT_BINARY_PAYLOAD),
        FRAME_KIND_EVENT => Some(MAX_EVENT_PAYLOAD),
        _ => None,
    }
}

fn validate_payload_len(kind: u8, len: u32) -> Result<()> {
    let max = max_payload_for_kind(kind).ok_or(CodecError::UnknownKind(kind))?;
    if len > max { return Err(CodecError::FrameTooLarge(len)); }
    Ok(())
}

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
    pub data: Arc<Vec<u8>>,
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

fn checked_output_payload_len(data_len: usize) -> Result<u32> {
    let payload_len = 24usize
        .checked_add(data_len)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or(CodecError::FrameTooLarge(u32::MAX))?;
    validate_payload_len(FRAME_KIND_OUTPUT_BINARY, payload_len)?;
    Ok(payload_len)
}

fn output_frame_header(out: &OutputFrame) -> Result<[u8; 29]> {
    let payload_len = checked_output_payload_len(out.data.len())?;
    let mut header = [0u8; 29];
    header[0] = FRAME_KIND_OUTPUT_BINARY;
    header[1..5].copy_from_slice(&payload_len.to_be_bytes());
    header[5..21].copy_from_slice(out.session_id.as_bytes());
    header[21..29].copy_from_slice(&out.seq.to_be_bytes());
    Ok(header)
}

async fn write_all_vectored_async<W>(w: &mut W, bufs: &mut [IoSlice<'_>]) -> io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    let mut remaining = bufs;
    while !remaining.is_empty() {
        let written = w.write_vectored(remaining).await?;
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "failed to write frame",
            ));
        }
        IoSlice::advance_slices(&mut remaining, written);
    }
    Ok(())
}

pub fn write_frame<W: Write>(w: &mut W, frame: &Frame) -> Result<()> {
    if let Frame::OutputBinary(out) = frame {
        let header = output_frame_header(out)?;
        w.write_all(&header)?;
        w.write_all(out.data.as_slice())?;
        return Ok(());
    }
    let (kind, payload) = encode_payload(frame)?;
    validate_payload_len(kind, payload.len() as u32)?;
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
    validate_payload_len(kind, len)?;
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
    validate_payload_len(kind, len)?;
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload).await?;
    decode_payload(kind, &payload)
}

pub async fn write_frame_async<W>(w: &mut W, frame: &Frame) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    if let Frame::OutputBinary(out) = frame {
        let header = output_frame_header(out)?;
        write_all_vectored_async(
            w,
            &mut [IoSlice::new(&header), IoSlice::new(out.data.as_slice())],
        )
        .await?;
        w.flush().await?;
        return Ok(());
    }
    let (kind, payload) = encode_payload(frame)?;
    validate_payload_len(kind, payload.len() as u32)?;
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
                data: Arc::new(payload[24..].to_vec()),
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
    use std::pin::Pin;
    use std::task::{Context, Poll};

    #[derive(Default)]
    struct AsyncVectoredOnlyWriter {
        bytes: Vec<u8>,
    }

    impl tokio::io::AsyncWrite for AsyncVectoredOnlyWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Err(io::Error::other("scalar async write used")))
        }

        fn poll_write_vectored(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            bufs: &[IoSlice<'_>],
        ) -> Poll<io::Result<usize>> {
            let limit = 7;
            let mut written = 0;
            for buf in bufs {
                let take = (limit - written).min(buf.len());
                self.bytes.extend_from_slice(&buf[..take]);
                written += take;
                if written == limit {
                    break;
                }
            }
            Poll::Ready(Ok(written))
        }

        fn is_write_vectored(&self) -> bool {
            true
        }
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

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
            data: Arc::new(b"hello\x1b[Hworld".to_vec()),
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

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn output_payload_length_rejects_values_above_u32_without_allocation() {
        assert!(matches!(
            checked_output_payload_len(u32::MAX as usize + 1),
            Err(CodecError::FrameTooLarge(u32::MAX))
        ));
    }

    #[test]
    fn sync_output_binary_rejects_oversized_payload_before_writing() {
        let frame = Frame::OutputBinary(OutputFrame {
            session_id: nil(),
            seq: 42,
            data: Arc::new(vec![0; MAX_OUTPUT_BINARY_PAYLOAD as usize - 24 + 1]),
        });
        let mut writer = Vec::new();

        assert!(matches!(
            write_frame(&mut writer, &frame),
            Err(CodecError::FrameTooLarge(length)) if length == MAX_OUTPUT_BINARY_PAYLOAD + 1
        ));
        assert!(writer.is_empty());
    }

    #[tokio::test]
    async fn async_output_binary_uses_partial_safe_scatter_gather_writes() {
        let frame = Frame::OutputBinary(OutputFrame {
            session_id: nil(),
            seq: 42,
            data: Arc::new(b"shared-output".to_vec()),
        });
        let mut writer = AsyncVectoredOnlyWriter::default();

        write_frame_async(&mut writer, &frame)
            .await
            .expect("vectored frame write");

        assert_eq!(read_frame(&mut Cursor::new(writer.bytes)).unwrap(), frame);
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
        // length header announces 128MiB which exceeds MAX_FRAME_PAYLOAD
        let buf = vec![FRAME_KIND_INPUT_BINARY, 0x08, 0x00, 0x00, 0x00];
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur) {
            Err(CodecError::FrameTooLarge(_)) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn rejects_payloads_above_their_frame_kind_budget_before_allocation() {
        for (kind, length) in [
            (FRAME_KIND_INPUT_BINARY, MAX_INPUT_BINARY_PAYLOAD + 1),
            (FRAME_KIND_CONTROL_REQUEST, MAX_CONTROL_REQUEST_PAYLOAD + 1),
            (FRAME_KIND_OUTPUT_BINARY, MAX_OUTPUT_BINARY_PAYLOAD + 1),
            (FRAME_KIND_EVENT, MAX_EVENT_PAYLOAD + 1),
        ] {
            let mut buf = vec![kind];
            buf.extend_from_slice(&length.to_be_bytes());
            let mut cur = Cursor::new(buf);
            assert!(matches!(read_frame(&mut cur), Err(CodecError::FrameTooLarge(n)) if n == length));
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
        let out = OutputFrame { session_id: nil(), seq: 1, data: Arc::new(b"abc".to_vec()) };
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

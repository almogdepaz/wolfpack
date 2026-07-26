# Wolfpack broker protocol (v1)

The Rust broker daemon owns every PTY/session in Wolfpack. Wolfpack's Bun
server is a client of the broker and never owns terminal child processes.
This document is the authoritative wire-level contract for that client/broker
boundary.

The contract has two strictly separate planes carried over a single transport:

- **Control plane** — JSON-encoded request/response and async event frames.
- **Live-output plane** — binary output and stdin frames carrying raw PTY bytes
  with no JSON envelope.

Control messages and stdin bytes share the transport but never share a frame.

---

## Transport

- One Unix domain socket per host (default: `$XDG_RUNTIME_DIR/wolfpack-broker.sock`,
  fall back to `~/.wolfpack/broker.sock`).
- Wolfpack opens **one persistent connection** per process and multiplexes all
  sessions over it. The broker tolerates arbitrary numbers of concurrent
  connections; each connection is its own subscription scope.
- The broker does not perform authentication on the socket — the socket's
  filesystem permissions (0600 + per-user runtime dir) are the auth boundary.

The transport is byte-oriented. The protocol layer on top is framed.

---

## Frame format

Every frame on the wire has a 5-byte header:

```
+--------+-------------------+-------------------------+
| 1 byte | 4 bytes (BE u32)  | N bytes payload         |
| kind   | payload length    | (kind-dependent)        |
+--------+-------------------+-------------------------+
```

- `kind`: frame kind discriminator (see table below).
- `payload length`: number of payload bytes that follow, big-endian unsigned 32.
- A receiver MUST reject any frame whose declared payload length exceeds
  `MAX_FRAME_PAYLOAD` (64 MiB). This caps a misbehaving peer's blast radius.
  The cap was raised from the original 16 MiB once heavy TUI snapshots
  (Claude with full scrollback + per-cell SGR) were observed to exceed
  16 MiB on the wire.

### Frame kinds

| Kind | Name              | Direction          | Payload encoding         |
|------|-------------------|--------------------|--------------------------|
| 0x01 | `control_request` | client → broker    | UTF-8 JSON object        |
| 0x02 | `control_response`| broker → client    | UTF-8 JSON object        |
| 0x03 | `output_binary`   | broker → client    | binary header + bytes    |
| 0x04 | `input_binary`    | client → broker    | binary header + bytes    |
| 0x05 | `event`           | broker → client    | UTF-8 JSON object        |

Reading any other kind byte is a protocol violation; the receiver SHOULD log
and close the connection.

---

## Control plane

### Request envelope

```json
{
  "id": <u64 monotonic per connection>,
  "method": "<method-name>",
  "params": { ... }
}
```

- `id` is chosen by the client and must be unique while a response is
  outstanding. The broker echoes it on the matching response.
- `method` is one of the strings listed below.
- `params` is always a JSON object. Methods that take no parameters use `{}`.

### Response envelope

```json
{
  "id": <same id from the request>,
  "status": "ok" | "error",
  "payload": { "kind": "<method-name>", ... },   // present iff status == "ok"
  "error":   { "code": "<code>", "message": "<human-readable>" } // present iff status == "error"
}
```

- The `payload.kind` discriminator mirrors the request method, so a client
  can route responses positionally or by tag.
- A response carries either `payload` or `error`, never both.

### Error codes

| Code                    | When |
|-------------------------|------|
| `invalid_request`       | malformed envelope, missing required params, bad types |
| `unknown_method`        | `method` is not in the spec |
| `unknown_session`       | `session_id` does not match a tracked session |
| `duplicate_session_name`| `create_session` requested a name that's already in use |
| `session_not_alive`     | operation requires a live session (kill on a dead session, etc.) |
| `spawn_failed`          | broker could not fork/exec the requested command |
| `resize_failed`         | TIOCSWINSZ failed |
| `internal_error`        | broker bug; correlate by id and inspect broker log |
| `unsupported`           | feature not yet implemented in this protocol version |

### Method reference

#### `list_sessions`

Returns the broker's current session table.

- params: `{}`
- ok payload:
  ```json
  { "kind": "list_sessions", "sessions": [SessionInfo, ...] }
  ```

#### `create_session`

Spawns a new PTY session under the broker.

- params:
  ```json
  {
    "name":    "agent"            (optional, broker assigns one if omitted),
    "cwd":     "/abs/path",
    "command": ["bash", "-l"],
    "env":     [["KEY", "VALUE"], ...]   (optional, default []),
    "cols":    120,
    "rows":    30
  }
  ```
- ok payload:
  ```json
  { "kind": "create_session", "session": SessionInfo }
  ```
- failure modes: `duplicate_session_name`, `spawn_failed`, `invalid_request`.

#### `kill_session`

Sends a signal to the session's leader process. Default signal is `SIGHUP`.

- params:
  ```json
  { "session_id": "<uuid>", "signal": 15 }
  ```
- ok payload:
  ```json
  { "kind": "kill_session", "killed": true }
  ```
- The session's `alive` flag transitions to `false` when the child reaps.
  Final transition is announced via a `session_exited` event.

#### `session_info`

Returns the metadata for a single session.

- params: `{ "session_id": "<uuid>" }`
- ok payload: `{ "kind": "session_info", "session": SessionInfo }`

#### `snapshot`

Returns a self-contained reconnect snapshot for one session. Detail in the
[Snapshot payload](#snapshot-payload) section.

- params:
  ```json
  {
    "session_id":       "<uuid>",
    "scrollback_lines": 5000      (optional cap; broker policy default if omitted)
  }
  ```
- ok payload: `{ "kind": "snapshot", "snapshot": Snapshot }`

#### `resize`

Resizes the PTY. Idempotent for `cols`/`rows` already in effect.

- params: `{ "session_id": "<uuid>", "cols": 120, "rows": 30 }`
- ok payload: `{ "kind": "resize", "ok": true }`
- The broker emits a `session_resized` event so other subscribers stay in sync.

#### `subscribe`

Asks the broker to begin streaming `output_binary` frames for a session on
this connection. This is the only way live output reaches the client.

- params:
  ```json
  {
    "session_id": "<uuid>",
    "since_seq":  0    (optional; if set, broker sends cached bytes from after
                       this seq before catching up to live)
  }
  ```
- ok payload:
  ```json
  { "kind": "subscribe", "ok": true, "current_seq": 12345 }
  ```
- After this response, `output_binary` frames for `session_id` may arrive at
  any time on the same connection.
- A connection can be subscribed to multiple sessions simultaneously; frames
  are demultiplexed by the `session_id` in the binary header.

#### `unsubscribe`

Stops `output_binary` delivery for a session on this connection. Any frames
already in flight may still arrive; clients dedupe by `seq`.

- params: `{ "session_id": "<uuid>" }`
- ok payload: `{ "kind": "unsubscribe", "ok": true }`

---

## Live-output plane

### `output_binary` (kind `0x03`)

Binary payload layout:

```
+----------------+---------------+-------------------+
| 16 bytes       | 8 bytes       | N bytes           |
| session_id     | seq (BE u64)  | raw PTY bytes     |
+----------------+---------------+-------------------+
```

- `session_id`: raw 16-byte UUID for the session this output belongs to.
- `seq`: monotonic broker-assigned PTY-chunk watermark. Each PTY read receives
  one sequence number. A frame may contain one chunk or several contiguous
  chunks coalesced by the broker; `seq` is the final chunk covered by the frame.
  `subscribe.since_seq` uses the same chunk numbering.
- `raw PTY bytes`: exactly what the covered PTY chunks emitted, concatenated in
  sequence order with no transformation. The client must not interpret these
  as JSON.
- Output frames remain ordered by `seq` within a session. Control responses and
  lifecycle events use a prioritized queue and may overtake already-queued
  output frames so PTY bursts cannot starve request handling.

### `input_binary` (kind `0x04`)

Binary payload layout:

```
+----------------+--------------------+
| 16 bytes       | N bytes            |
| session_id     | raw stdin bytes    |
+----------------+--------------------+
```

- `session_id`: target session.
- `raw stdin bytes`: written verbatim to the PTY master.
- There is no client-side seq for input frames. Broker writes are best-effort
  in arrival order on the connection and never reordered across `input_binary`
  frames for the same session.

This frame is the canonical stdin path. Stdin bytes never travel through
control-plane JSON.

---

## Event plane

`event` frames (kind `0x05`) deliver async signals from broker to client and
are not tied to any request `id`.

```json
{ "event": "<event-name>", ... }
```

| Event                 | Body fields                                      |
|-----------------------|--------------------------------------------------|
| `session_started`     | `session: SessionInfo`                           |
| `session_exited`      | `session_id, exit_code?, signal?`                |
| `session_resized`     | `session_id, cols, rows`                         |
| `snapshot_invalidated`| `session_id` — clients SHOULD re-`snapshot`      |
| `subscription_dropped`| `session_id, lagged` — re-subscribe from the last delivered `seq` |

Lifecycle events are best-effort and global: a connection may receive them
without subscribing to the affected session. They use the prioritized control
queue and can overtake output. `subscription_dropped` is different: it is sent
only to the affected connection through its output queue, after all previously
accepted output frames. That ordering barrier makes replay from the client's
last delivered `seq` safe.

---

## SessionInfo

```jsonc
{
  "id":            "550e8400-e29b-41d4-a716-446655440000",  // UUID v4
  "name":          "agent",
  "cwd":           "/Users/almog/Dev/wolfpack",
  "command":       ["bash", "-l"],
  "env":           [["FOO", "bar"]],                        // [] if unused
  "cols":          120,
  "rows":          30,
  "pid":           54321,                                    // null if not spawned
  "started_at_ms": 1700000000000,                            // unix epoch ms
  "alive":         true,
  "exit_code":     null                                      // i32 once exited
}
```

---

## Snapshot payload

The snapshot is the canonical reconnect surface. Its purpose: a fresh attach
must restore the visible screen, prior scrollback, and ANSI-faithful state
from broker-owned memory only — no browser-local cache, no second history
source.

```jsonc
{
  "session_id":     "<uuid>",
  "seq":            12345,           // last PTY chunk covered by this snapshot
  "cols":           120,
  "rows":           30,
  "visible_screen": [StyledLine; rows],   // top-to-bottom, exactly `rows` entries
  "scrollback":     [StyledLine; ...],    // oldest first; capped per request
  "cursor":         CursorState,
  "modes":          TerminalModes,
  "scroll_region":  { "top": 0, "bottom": 29 },
  "title":          "agent" | null,
  "captured_at_ms": 1700000000000
}
```

Reconnect contract: a client that applies `visible_screen`, `cursor`, and
`modes`, prepends `scrollback`, and then resumes from `output_binary` frames
where `seq > snapshot.seq` MUST land on a state visually and semantically
equivalent to a viewer that had been attached the whole time.

### StyledLine

```jsonc
{ "cells": [StyledCell, ...] }
```

A line MAY be shorter than `cols`. Shorter lines are right-padded with blank
cells using the default attrs.

### StyledCell

```jsonc
{
  "ch":    "a",       // single grapheme cluster (1+ codepoints)
  "attrs": CellAttrs
}
```

### CellAttrs

```jsonc
{
  "fg":        16777215 | null,   // 24-bit RGB packed; null = default fg
  "bg":        0        | null,
  "bold":      false,
  "italic":    false,
  "underline": false,
  "reverse":   false,
  "blink":     false,
  "strike":    false,
  "dim":       false,
  "hidden":    false
}
```

### CursorState

```jsonc
{
  "row":     5,                 // 0-based, inside visible_screen
  "col":     12,
  "visible": true,
  "shape":   "block" | "underline" | "bar"
}
```

### TerminalModes

```jsonc
{
  "alt_screen":          false,        // DECSET 1049
  "application_cursor":  false,        // DECSET 1
  "application_keypad":  false,        // DECKPAM
  "bracketed_paste":     false,        // DECSET 2004
  "mouse_mode":          "off" | "x10" | "vt200" | "button_event" | "any_event" | "sgr",
  "origin_mode":         false,        // DECSET 6
  "auto_wrap":           true,         // DECSET 7
  "insert_mode":         false         // IRM
}
```

The broker is responsible for keeping these fields in sync with the actual
PTY-driven terminal model. Adding fields here is a non-breaking change as
long as deserializers default-fill unknown fields.

---

## Versioning

- The crate exposes `wolfpack_broker::protocol::PROTOCOL_VERSION` (currently
  `2`).
- Breaking changes (renaming methods, removing fields, changing frame layout,
  changing length-prefix encoding) bump the version.
- Additive changes (new methods, new payload kinds, new optional fields, new
  events) do not bump the version. Clients must ignore unknown fields and
  unknown event names.
- `unknown_method` is the protocol's "unknown verb" error: a v1 client talking
  to a v2 broker that requested a v2-only method would get this rather than a
  silent drop.

---

## Test surface

The `wolfpack-broker` crate carries unit tests for:

- JSON roundtrip of every control method's params and response payload.
- JSON roundtrip of every `Event` variant.
- JSON roundtrip of `Snapshot` and its nested types.
- Frame codec write/read roundtrip for every frame kind.
- Codec rejection paths: unknown kind, oversized frame, short binary header.
- Back-to-back frame streaming on a single buffer.

Run with `cargo test --manifest-path broker/Cargo.toml`.

---
name: wolfpack-tailnet-control
description: Use when an agent needs to find, inspect, or take control of Wolfpack terminal sessions on machines reachable through the same Tailscale tailnet.
---

# Wolfpack Tailnet Session Control

Use this when you need to look up or control Wolfpack sessions on this machine or another machine in the same tailnet.

## Trust and safety

- Treat every Wolfpack session as a live user terminal. Read before writing.
- Prefer the Wolfpack web UI for interactive control. Only use the low-level WebSocket protocol when automation is explicitly needed.
- Do not kill, take over, or send input to a session unless the user asked for that exact action.
- Tailscale is the primary network boundary. If the server has JWT auth enabled, include `Authorization: Bearer <token>` on HTTP requests. For browser-style WebSocket clients that cannot set headers, append `?token=<jwt>` alongside `session`.

## Find Wolfpack hosts

Local config usually tells you the current host and port:

```bash
jq -r '.tailscaleHostname // empty, .port // 18790' ~/.wolfpack/config.json
```

Discover other Wolfpack servers from any running Wolfpack host:

```bash
BASE="https://$(jq -r '.tailscaleHostname' ~/.wolfpack/config.json)"
curl -fsS "$BASE/api/discover" | jq .
```

Each peer has a `url` like `https://machine.tailnet.ts.net`. Use that URL as `BASE` for the commands below.

## List and inspect sessions

List sessions:

```bash
curl -fsS "$BASE/api/sessions" | jq .
```

Read the terminal pane for one session:

```bash
SESSION="my-session"
curl -fsS "$BASE/api/poll?session=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SESSION")" | jq -r .pane
```

Fetch plain text for copy/debugging:

```bash
curl -fsS "$BASE/api/copy-text?session=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SESSION")"
```

Check a session repo's git status:

```bash
curl -fsS "$BASE/api/git-status?session=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SESSION")" | jq -r .status
```

## Create or kill sessions

Create a session in an existing project under the host's configured `devDir`:

```bash
curl -fsS "$BASE/api/create" \
  -H 'Content-Type: application/json' \
  -d '{"project":"repo-name","cmd":"claude","sessionName":"repo-name-claude"}' | jq .
```

Kill only when explicitly requested:

```bash
curl -fsS "$BASE/api/kill" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg session "$SESSION" '{session:$session}')" | jq .
```

## Interactive control

Recommended path: open the Wolfpack UI at `$BASE`, choose the machine/session, then use the terminal. If another viewer owns the PTY, Wolfpack shows a take-control flow; confirm only if the user asked you to take over.

Low-level protocol for automation:

1. Connect to `wss://host/ws/pty?session=<name>`; if JWT auth is enabled and you cannot set headers, use `wss://host/ws/pty?session=<name>&token=<jwt>`.
2. Send JSON attach first: `{"type":"attach","cols":120,"rows":40,"prefillMode":"full"}`.
3. If the server replies `viewer_conflict`, do not take over unless requested. To take over, either send `{"type":"take_control"}` after attach, or reconnect and include `"takeControl":true` in the attach message.
4. Terminal output arrives as binary frames. Terminal input must be sent as binary UTF-8 bytes.
5. Resize with `{"type":"resize","cols":120,"rows":40}`.

Minimal Bun example:

```ts
const base = process.env.BASE!; // e.g. https://machine.tailnet.ts.net
const session = process.env.SESSION!;
const wsUrl = base.replace(/^http/, "ws") + "/ws/pty?session=" + encodeURIComponent(session);
const ws = new WebSocket(wsUrl);

ws.binaryType = "arraybuffer";
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "attach", cols: 120, rows: 40, prefillMode: "full" }));
});
ws.addEventListener("message", (event) => {
  if (typeof event.data === "string") console.error("control", event.data);
  else process.stdout.write(Buffer.from(event.data));
});

// after attach, send one command and enter:
setTimeout(() => ws.send(Buffer.from("git status\r", "utf8")), 1000);
```

## Notify the user

A session can send a Wolfpack push notification through the local host:

```bash
curl -fsS http://localhost:18790/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"agent needs input"}'
```

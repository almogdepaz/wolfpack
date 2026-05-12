# Broker stall — wedged-but-handshaking state

## Symptom

`wolfpack-broker` keeps the unix socket open and answers the initial protocol
handshake, but every subsequent RPC (`list_sessions`, `subscribe`, etc.) hangs
until the 10s client timeout. From the server's point of view the broker looks
"reachable" but is functionally dead.

Server log (snippet):

```
"msg":"broker handshake ok"
"msg":"broker reachable"
…
"error":"BrokerRequestTimeoutError: broker request 'list_sessions' timed out after 10000ms"
"error":"BrokerRequestTimeoutError: broker request 'subscribe' timed out after 10000ms"
```

## Observed on this machine

- broker PID 66555, uptime **5 days**, RSS **686MB**, CPU **~24% steady**
- two specific session UUIDs (`9bf96cf8-…`, `423de1e8-…`) trigger
  `subscription forwarder lagged broadcast` warnings continuously for 3+ days
- `broker writer failed; closing connection — Broken pipe (os error 32)` repeats
  every few hours from 2026-05-08 onward
- launchd-managed `wolfpack` server can't tell broker is wedged because the
  handshake succeeds, so it never restarts the connection — instead it loops on
  request timeouts forever

## Likely root causes (Rust, `broker/src/`)

1. **Handshake and request paths don't share fate.** Broker passes liveness
   checks (handshake reply) while the request handler task is stuck or starved.
2. **No connection eviction on repeated broken-pipe writes.** A half-dead
   client keeps the broker busy logging `os error 32` indefinitely.
3. **Subscription forwarder lag loop.** When a subscriber falls behind on the
   broadcast channel, broker logs `lagged broadcast` and tries to re-notify,
   but nothing actually drains or evicts the slow subscriber — so it lags
   again immediately. Plausible source of steady CPU + RSS growth.

## Recovery (manual, no code change)

```sh
launchctl kickstart -k gui/$(id -u)/com.wolfpack.broker
launchctl kickstart -k gui/$(id -u)/com.wolfpack.server   # server's socket is now dead, must reattach
```

After kickstart the new broker is at PID 23926 (3MB RSS, 0% CPU), server
re-handshakes cleanly, `/api/sessions` returns 200.

## Not yet investigated

- Whether a single misbehaving subscriber can wedge the broker for all clients,
  or whether the wedge is per-connection.
- Whether the lag-broadcast warnings precede the wedge or are independent.
- Whether the leaked RSS is in the ring buffer, the broadcast channel backlog,
  or somewhere else.

## Action items

- [ ] Add a request-path liveness probe (current handshake-only check is
      insufficient).
- [ ] Evict client connection after N consecutive write errors instead of
      logging every one forever.
- [ ] Decide a policy for chronically-lagging subscribers: force-disconnect or
      drop their backlog. Continuous "notify to re-subscribe" with no
      enforcement is a busy loop.
- [ ] Add a metric / log line on broker startup so we can correlate wedges
      against broker uptime.

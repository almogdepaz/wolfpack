# Mobile Agent Workflow

Wolfpack is built for the boring but real workflow: start agents on real machines, leave your desk, then answer only when something needs you.

## Triage loop

1. Open the Wolfpack PWA on your phone.
2. Scan the session cards.
3. Prioritize sessions marked needs-input or idle with a prompt visible.
4. Open only the session that needs attention.
5. Send the smallest useful response, then go back to the session list.

Avoid doom-scrolling terminals. The card preview is there so you can decide whether to open the terminal at all.

## Session states

Wolfpack cards are intentionally coarse:

- **running** — output changed recently; the agent is probably busy.
- **idle** — output is stable; it may be waiting at a prompt or just done.
- **needs input** — Wolfpack sees prompt-like output that likely needs you.

These are triage hints, not a formal agent protocol. When in doubt, open the terminal.

## Responding from phone

The terminal view includes mobile-oriented controls:

- keyboard toggle so the phone keyboard stays out of the way until needed.
- accessory keys for common terminal input like arrows and Esc.
- reconnect behavior for spotty mobile networks.
- long-running sessions stay alive on the machine even if the phone disconnects.

Good mobile responses are short:

```text
y
```

```text
continue, but keep scope to docs only
```

```text
run the focused test first, then stop
```

## Multi-session habits

Use names that make the phone list obvious:

```text
<project>-<task>-<agent>
```

Examples:

```text
wolfpack-readme-claude
api-regression-codex
linux-build-pi
```

For many sessions, prefer one agent per task. If a task becomes broad, stop the agent and split the task instead of letting one terminal become a mystery blob.

## PWA cache weirdness

After upgrades, a home-screen PWA can hold onto stale assets longer than a normal browser tab.

If the UI looks stale after an update:

1. fully close the PWA.
2. reopen it.
3. if still stale, open the same URL in the browser and refresh.
4. run `wolfpack doctor` on the machine.

## When to use desktop grid instead

Use desktop grid when you need to watch several terminals at once or copy larger text between sessions.

Use phone view when you only need to answer prompts, check status, or kick off a quick command.

## Safety reminder

Anyone who can access Wolfpack can interact with shells on that machine. Use Tailscale, consider JWT auth for shared tailnets, and treat Wolfpack access like shell access.

# Agent Context extension sample

A publishable static Wolfpack extension package. Its generated `dist/ui.js` is self-contained and uses only `wolfpack-bridge/extensions` while authoring; installation never runs a compiler or package script.

The contribution registers the local `context` view and the explicit **Lead + stack** recipe. Installing it does not select either contribution. Use normal host controls to select the view and recipe.

The view labels data as agent-authored, displays the exact scope UUID and subscription revision, and renders document strings through DOM `textContent`. Its textarea is a namespaced local draft only; it is not published context.

## Install and skill ownership

Install from an owned local snapshot with explicit browser-code and Pi-skill consent:

```sh
wolfpack extensions install /absolute/path/to/agent-context --trust-browser-code --skills pi
```

The installer reports skill ownership separately. A collision or user-modified deployed skill is not overwritten; inspect that status before retrying. Remove the package with the same explicit skills root when needed. Existing Pi sessions need normal `/reload` or a new session before discovery changes apply; do not steer a live agent automatically.

In a fresh session launched by the updated broker, ask the agent to “update this session's context.” The skill uses `wolfpack session current-context --json` to verify its UUID automatically; no copied ID or extra confirmation is needed. Another session still requires an explicit UUID. Old sessions are intentionally unsupported; upgrading the broker terminates existing terminals, so schedule that upgrade first.

See `skills/wolfpack-agent-context/SKILL.md` for verified exact-scope CAS publication guidance.

## Opt-in real-agent acceptance (not run here)

The real-agent gate requires explicit approval for a provider/model invocation, a disposable Wolfpack HOME/broker/server/browser, a fixed exact scope UUID, and a normal Pi session that has loaded this installed skill. Capture structured Pi tool records for the public CLI read/publish calls, then independently verify the accepted revision through CLI/API and browser DOM. Do not substitute a scripted harness or terminal text for that evidence, and redact credentials/tool payloads before any handoff. This package/component coverage does not claim that gate.

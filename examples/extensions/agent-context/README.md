# Agent Context extension sample

A publishable static Wolfpack extension package. Its generated `dist/ui.js` is self-contained and uses only `wolfpack-bridge/extensions` while authoring; installation never runs a compiler or package script.

The contribution registers only the local `context` view. The host opens a sole view once its catalog is ready and the context panel is visible; installation/registration alone stays inert. Terminal layouts belong to the host's layout picker. Its **Lead + stack** keeps the first pane as lead across focus and machine changes; reorder panes to change the lead.

The old duplicate `agent-context/lead-stack` recipe is no longer contributed. Browsers with that saved recipe use the host's existing missing-recipe fallback (Equal grid); select the built-in **Lead + stack** once to retain that layout. Other recipes and context data are unaffected.

The view is a compact, theme-aware session brief: a clear goal, separated headline/detail disclosures, visible plan statuses and reported progress, prominent blockers, and numbered next steps. Each bullet expands independently with native keyboard/touch controls. Stable plan IDs and other item headlines retain expansion and focused rows across revisions and reordering. Headlines and details are separated by a blank line inside existing text strings; the installed schema is unchanged, so updates require no migration. Legacy plain-text items remain fully readable without invented summaries or empty expanders.

The revision and agent-authored label stay visible; the exact UUID and provenance explanation live under **Session details**. **Local draft** is a collapsed, namespaced browser-only scratchpad, not a context editor or publication action. Existing drafts are retained. Document strings are assigned through DOM `textContent`, never interpreted as HTML. Extension-scoped styles ship inside its own UI bundle and inherit host theme tokens when available; no host CSS or terminal geometry changes are required.

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

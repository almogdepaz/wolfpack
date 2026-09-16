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

See `skills/wolfpack-agent-context/SKILL.md` for exact-scope CAS publication guidance. This sample does not claim browser/real-agent acceptance by itself.

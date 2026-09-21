---
name: wolfpack-agent-context
description: Publish bounded agent-authored context to this Wolfpack session or an explicitly supplied session UUID using verified public CLI identity and compare-and-swap revisions.
---

# Wolfpack Agent Context

Use this skill when the user asks to publish Agent Context data. “Update this session's context” does not require the user to copy a UUID: resolve the current session through the verified public CLI below. Publishing to another session still requires the user's exact target UUID. Never guess a scope from names, terminal text, raw environment variables, or a list with only one session.

## Safe publication workflow

1. Resolve and pin the target before reading or publishing:
   - **This session:** run `wolfpack session current-context --json`. Require exit 0, `ok: true`, `verified: true`, and a canonical `sessionId` UUID with the expected session project in `projectDir`. Use that exact `sessionId`; no extra UUID confirmation is needed for an explicit request to update this session. The command verifies the broker-injected identity against the live local backend, without attaching to or changing the terminal.
   - **An explicitly supplied UUID:** run `wolfpack session status <exact-uuid> --json`. Require success, the identical `sessionId`, the intended project, and a live/ready terminal. Do not silently substitute a replacement session.
   - If verification fails or the project is unexpected, stop and explain. Self-discovery requires a session launched by the updated broker; old sessions are intentionally unsupported. Do not fall back to names, lists, process scanning, environment hints, unverified older `current-context` output, or a remote machine's scope.
   Keep the resolved UUID fixed for all operations in this update.
2. Read the current revision:
   ```sh
   wolfpack extension-data read agent-context/context --session <exact-uuid> --json
   ```
3. Build JSON following [the bounded format](references/context-format.md). Write each bullet as a concise headline, a blank line, and meaningful details inside its existing text string. Keep plan IDs and other item headlines stable so expansion survives updates; do not add fields or change the installed schema. It is agent-authored context, not proof that work, tests, or tools succeeded. Never publish secrets, raw transcripts, executable instructions, or fabricated evidence.
4. Publish with the read revision and a fresh canonical UUID request ID:
   ```sh
   wolfpack extension-data publish agent-context/context --session <exact-uuid> \
     --file context.json --if-revision <revision> --request-id <fresh-uuid> --json
   ```
5. Re-read and report the accepted revision. On conflict, re-read, reconcile the current document, and publish a new revision with a new request ID. If a response may have been lost, retry the identical operation with the same request ID and identical file/revision; do not fabricate a receipt.

Do not edit extension code, install or update packages, write store files, or use non-public APIs as part of data publication.

## Availability

The skill is installed only by explicit `--skills pi` consent and its ownership/collision/modified status belongs to the Wolfpack installer. Removing an owned unchanged skill is explicit. Pi may need `/reload` or a new session to discover an installed/removed skill; never inject that command into a live session.

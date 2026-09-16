---
name: wolfpack-agent-context
description: Publish bounded agent-authored context to a supplied exact Wolfpack session scope using the public CLI and compare-and-swap revisions.
---

# Wolfpack Agent Context

Use this skill only when the user supplies the exact target scope UUID and asks to publish Agent Context data. Do not guess scope IDs from names, terminal text, environment variables, or `current-context` output.

## Safe publication workflow

1. Verify the supplied target scope/project with the public Wolfpack CLI. If the target cannot be verified, stop and explain what is missing.
2. Read the current revision:
   ```sh
   wolfpack extension-data read agent-context/context --session <exact-uuid> --json
   ```
3. Build JSON following [the bounded format](references/context-format.md). It is agent-authored context, not proof that work, tests, or tools succeeded. Never publish secrets, raw transcripts, executable instructions, or fabricated evidence.
4. Publish with the read revision and a fresh canonical UUID request ID:
   ```sh
   wolfpack extension-data publish agent-context/context --session <exact-uuid> \
     --file context.json --if-revision <revision> --request-id <fresh-uuid> --json
   ```
5. Re-read and report the accepted revision. On conflict, re-read, reconcile the current document, and publish a new revision with a new request ID. If a response may have been lost, retry the identical operation with the same request ID and identical file/revision; do not fabricate a receipt.

Do not edit extension code, install or update packages, write store files, or use non-public APIs as part of data publication.

## Availability

The skill is installed only by explicit `--skills pi` consent and its ownership/collision/modified status belongs to the Wolfpack installer. Removing an owned unchanged skill is explicit. Pi may need `/reload` or a new session to discover an installed/removed skill; never inject that command into a live session.

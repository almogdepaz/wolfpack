# Agent Context document format

Publish one bounded JSON object:

```json
{
  "schemaVersion": 1,
  "goal": "Short current goal",
  "planItems": [{ "id": "plan-1", "text": "Describe the next bounded action", "status": "pending" }],
  "decisions": ["A decision and its reason"],
  "blockers": ["A concrete blocker, or []"],
  "nextSteps": ["A bounded next step"]
}
```

`status` is exactly one of `pending`, `in_progress`, `complete`, or `blocked`. Keep IDs stable when revising existing plan items. All strings are data rendered as text by the browser; do not place HTML, executable instructions, credentials, raw transcripts, or claims of independently verified execution in these fields.

The server validates byte/depth/item limits and the installed schema. A receipt means the document was stored at a revision; it does not prove that the browser rendered it, that an agent authored it, or that work completed.

# Agent Context document format

Publish one bounded JSON object. Write a short **headline** in each item's `text`, and put its supporting explanation in `details`. The widget shows headlines first; each item's details expand independently.

```json
{
  "schemaVersion": 1,
  "goal": "Make session context easier to scan",
  "planItems": [
    { "id": "item-disclosures", "text": "Add collapsible items", "details": "Give each item a clear headline and its own disclosure. Preserve expanded items when context updates.", "status": "in_progress" }
  ],
  "decisions": [
    { "id": "native-disclosures", "text": "Use native disclosures", "details": "Keyboard and touch users can open each item without custom interaction conventions." }
  ],
  "blockers": [],
  "nextSteps": [
    { "id": "review-sidebar", "text": "Review the narrow sidebar", "details": "Check headline wrapping, item separation and expanded details at the smallest supported width." }
  ]
}
```

- Prefer meaningful headlines of roughly 3–8 words, not entire paragraphs or labels like “Decision 1”. Keep explanation, rationale and caveats in `details`; do not repeat the headline there.
- Give every item a stable, unique `id` within its section. Keep it when revising or reordering the same item, so its expanded state follows it. Use a new ID for a different item.
- `status` is exactly `pending`, `in_progress`, `complete`, or `blocked`. These are agent-reported states, not independently verified execution.
- Use empty arrays for absent sections. Never create placeholder blockers or invent supporting detail just to fill the widget.
- Backward-compatible schema version 1 still accepts plain strings in `decisions`, `blockers` and `nextSteps`, and plan items without `details`. These remain fully readable but do not get empty expanders. Prefer structured items with genuine details for new publications.
- Structured non-plan items require `id` (1–128 characters), `text` (1–240) and `details` (1–16000). Plan `details` is optional for compatibility; when present it is nonempty and at most 16000 characters. The whole document must also fit the server's bounded byte/depth/item limits.

All strings are data rendered as text. Do not include HTML, executable instructions, credentials, raw transcripts, or fabricated evidence.

The server validates the installed schema. A receipt means the document was stored at a revision; it does not prove browser rendering, authorship or completed work.

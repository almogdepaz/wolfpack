# Agent Context document format

Publish one bounded JSON object using the existing version-1 schema. Each bullet is a text string: **short headline, blank line, supporting details**. The widget displays the headline first and lets the user expand each item independently.

```json
{
  "schemaVersion": 1,
  "goal": "Make session context easier to scan",
  "planItems": [
    { "id": "item-disclosures", "text": "Add collapsible items\n\nGive each item a clear headline and its own disclosure. Preserve expanded items when context updates.", "status": "in_progress" }
  ],
  "decisions": ["Use native disclosures\n\nKeyboard and touch users can open each item without custom interaction conventions."],
  "blockers": [],
  "nextSteps": ["Review the narrow sidebar\n\nCheck headline wrapping, item separation and expanded details at the smallest supported width."]
}
```

- Prefer meaningful headlines of roughly 3–8 words. Put explanation, rationale and caveats after the first blank line (`\n\n` in JSON), rather than repeating the headline. Further paragraphs stay in the expanded details.
- Keep plan `id` values stable and unique. For decisions, blockers and next steps, keep the headline stable when refining the same item's details. Expansion follows plan IDs or other item headlines across revisions/reordering. Distinct items should have distinct headlines.
- `status` is exactly `pending`, `in_progress`, `complete`, or `blocked`. These are agent-reported states, not independently verified execution.
- Use empty arrays for absent sections. Do not invent blockers, placeholder details or evidence to fill the widget.
- Existing single-paragraph strings remain fully readable; without actual details they do not show an empty expander. No schema migration is needed. Do not publish object entries in string arrays or add separate `details` fields: those are not part of the installed schema.
- Each string is at most 16000 characters and each list at most 200 items. The entire document must also fit the server's bounded byte/depth/item limits.

All strings are data rendered as text. Do not include HTML, executable instructions, credentials, raw transcripts, or fabricated evidence.

A receipt means the document was stored at a revision; it does not prove browser rendering, authorship or completed work.

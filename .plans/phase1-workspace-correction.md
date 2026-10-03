# Phase-1 workspace correction and native acceptance

- **Original lane base:** `345552eda3e4a489a9905b8a8278418a06deb150`
- **Reviewed candidate:** `d11472d32b1e64395a30647a64c31a65826eb276`
- **Tests-first commit:** `290b7c1ef70a9483b5f209021e39c254c160e9b3`
- **Implementation/budget correction:** `354c1de1f5c0f91a5e26df4d816eaeb4794044d6`
- **Native retention coverage:** `28341d113c1446ae42771c9939195af7629d1759`

## Closure

- **W1:** The host adapter now treats equal-grid as the existing surface-specific CSS geometry rather than applying the generic SDK helper. Manual three-pane retains the full-width final row; manual five-pane retains its established 6-track spans. The approved generic `equalGridLayout` remains unchanged.
- **W2:** Context full view clears split flex/width/height caps, including bottom/mobile overrides; the persisted split choice is restored. The recovery control is above the full context region and remains reachable.
- **W3:** Rendering caches one applied layout with its visible pane identities per manual/delegation surface. Keyboard navigation resolves the focused identity through that same cached layout, not window geometry or an unfiltered focus index. The existing collapsed-focused delegation regression now exercises that path.
- **W4:** Native fixture creates an owned temporary HOME, machine-id path and DEV_DIR, with broker helper-owned socket/server cleanup. Real desktop checks preserve equal-cardinality geometry, selected pane/canvas identity, nonzero resize frames, reversible context/collapse/full-view paths and no new attaches. Real WebKit checks hide/restore continuity plus retained draft value/selection. Explicit remove/ended/displaced paths remain destructive.
- **Budget:** only authorized app/CSS limits changed in `scripts/check-bundle-budgets.ts`: app `350000/87000`, CSS `102000/20000`; Ghostty and all other checks stay unchanged. Rationale documents phase-1 measured base/candidate sizes and keeps the gate active.

## Tests and evidence

- Red native tests-first run: **0 pass / 2 fail / 1 skipped**; default three-pane width regression (602px short) and narrow applied-layout keyboard regression, `664e78da-293d-4b63-aee5-8b7a007679ac`.
- Focused unit/layout/lifecycle + typecheck/context: **13 pass / 0 fail / 0 skip**, `fed0c592-40f5-480b-880c-a55812b2aebe`.
- Generated asset/budget + mocked desktop delegation: budget pass at app **349590 raw / 85735 gzip**, CSS **101093 / 17709**, Ghostty **643371 / 187737**; desktop **9 pass / 4 project skips**, `33481f1c-fd37-46f9-a07a-c931f7ede27d`.
- Mocked mobile WebKit: **1 pass**, `5460132d-cf33-41b6-adc3-2ade1e8f2a97`.
- Authorized real broker (`WOLFPACK_BROKER_BIN=/private/tmp/wolfpack-extensions-native.DCYC5T/wolfpack-broker`, SHA-256 `21c124a6f5251759c4b87e588eb2e4d2fbcfb2ed9557d29e36ce1f517eb42029`): desktop **3 pass / 1 project skip**, `453a036a-6a4f-4ac7-9126-fb0d3bc4f31b`; mobile WebKit **1 pass**, `fb37a1b1-4368-4170-8dd4-777c7cadd956`. All servers/brokers used temporary owned homes/ports/sockets; no operator broker/socket was used.
- Final broad clean-source `bun test tests/unit/ tests/snapshot/`: **2043 pass / 2 fail / 1 skip**, `7b70356f-8008-488c-b40e-2743ddfbe15c`, 139.72s. Both failures are unchanged unrelated `release artifact smoke` 5000ms timeouts; no timeout/test change was made. The skip is the macOS no-controlling-TTY install fixture.

## Changed files in correction

- `public/app-grid.ts`
- `public/terminal-layout-registry.ts`
- `public/styles.css`
- `scripts/check-bundle-budgets.ts`
- `tests/e2e/workspace-layout-broker.e2e.ts`

Generated `src/public-assets.ts` was restored and is not committed. Immutable parent review artifacts were not edited.

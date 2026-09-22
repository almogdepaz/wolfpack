/** Packaged with the extension, scoped to its own roots; no host stylesheet dependency. */
export const styles = `
.wolfpack-agent-context {
  --wac-bg: var(--bg-surface, #131715);
  --wac-border: var(--border-subtle, #28312b);
  --wac-text: var(--text-primary, #edf3ef);
  --wac-muted: var(--text-muted, #a4b2a9);
  --wac-accent: var(--accent, #45ed7e);
  display: grid; gap: 16px; max-width: 760px; min-width: 0; margin-inline: auto;
  color: var(--wac-text); font: 13px/1.55 var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  overflow-wrap: anywhere; container-type: inline-size;
}
.wolfpack-agent-context *, .wolfpack-agent-context *::before, .wolfpack-agent-context *::after { box-sizing: border-box; }
.wolfpack-agent-context[hidden], .wolfpack-agent-context [hidden] { display: none !important; }
.wolfpack-agent-context h2, .wolfpack-agent-context h3, .wolfpack-agent-context p, .wolfpack-agent-context ul { margin: 0; padding: 0; }
.wolfpack-agent-context .wac-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; color: var(--wac-muted); font-size: 11px; }
.wolfpack-agent-context .wac-revision { border: 1px solid var(--wac-border); border-radius: 6px; padding: 2px 7px; font-variant-numeric: tabular-nums; }
.wolfpack-agent-context .wac-goal { display: grid; gap: 8px; padding: 16px; border: 1px solid var(--wac-border); border-left: 2px solid var(--wac-accent); border-radius: 9px; background: var(--wac-bg); }
.wolfpack-agent-context .wac-eyebrow { color: var(--wac-accent); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.wolfpack-agent-context h2 { font-size: 17px; font-weight: 600; line-height: 1.45; letter-spacing: -.015em; text-wrap: pretty; }
.wolfpack-agent-context .wac-content { display: grid; gap: 20px; min-width: 0; }
.wolfpack-agent-context .wac-section { min-width: 0; display: grid; align-content: start; gap: 8px; }
.wolfpack-agent-context .wac-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wolfpack-agent-context h3 { color: var(--wac-muted); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.wolfpack-agent-context .wac-count { color: var(--wac-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.wolfpack-agent-context .wac-list { display: grid; gap: 8px; list-style: none; }
.wolfpack-agent-context .wac-item { border: 1px solid var(--wac-border); background: var(--wac-bg); border-radius: 9px; min-width: 0; overflow: clip; }
.wolfpack-agent-context .wac-item[data-status="blocked"] { border-color: var(--warning, #ebca78); }
.wolfpack-agent-context summary { list-style: none; cursor: pointer; }
.wolfpack-agent-context summary::-webkit-details-marker { display: none; }
.wolfpack-agent-context .wac-item summary { min-height: 44px; padding: 12px; }
.wolfpack-agent-context .wac-item summary:hover { background: var(--bg-hover, #1b231e); }
.wolfpack-agent-context summary:focus-visible, .wolfpack-agent-context button:focus-visible, .wolfpack-agent-context textarea:focus-visible { outline: 2px solid var(--wac-accent); outline-offset: -2px; border-radius: 5px; }
.wolfpack-agent-context .wac-caption { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.wolfpack-agent-context .wac-static { padding: 12px; }
.wolfpack-agent-context .wac-caption-text { display: grid; flex: 1; min-width: 0; gap: 4px; }
.wolfpack-agent-context .wac-title { font-weight: 500; line-height: 1.45; }
.wolfpack-agent-context .wac-status { color: var(--wac-muted); font-size: 10px; line-height: 1.4; }
.wolfpack-agent-context [data-status="complete"] .wac-marker { color: var(--wac-accent); }
.wolfpack-agent-context [data-status="in_progress"] .wac-marker, .wolfpack-agent-context [data-status="in_progress"] .wac-status { color: var(--cmd-accent, #66ccff); }
.wolfpack-agent-context [data-status="blocked"] .wac-marker, .wolfpack-agent-context [data-status="blocked"] .wac-status { color: var(--warning, #ebca78); }
.wolfpack-agent-context .wac-marker { flex: 0 0 16px; color: var(--wac-muted); font-size: 12px; font-weight: 600; text-align: center; line-height: 19px; font-variant-numeric: tabular-nums; }
.wolfpack-agent-context .wac-chevron { flex: 0 0 14px; width: 14px; height: 14px; margin-top: 3px; fill: none; stroke: var(--wac-muted); stroke-width: 1.6; transition: transform .15s ease; }
.wolfpack-agent-context details[open] > summary .wac-chevron { transform: rotate(90deg); }
.wolfpack-agent-context .wac-detail { padding: 10px 12px 12px 37px; border-top: 1px solid var(--wac-border); color: var(--text-secondary, #bac6be); font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
.wolfpack-agent-context .wac-progress { width: 100%; height: 3px; border: 0; border-radius: 3px; overflow: hidden; background: var(--wac-border); color: var(--wac-accent); accent-color: var(--wac-accent); }
.wolfpack-agent-context .wac-progress::-webkit-progress-bar { background: var(--wac-border); }
.wolfpack-agent-context .wac-progress::-webkit-progress-value { background: var(--wac-accent); }
.wolfpack-agent-context .wac-progress::-moz-progress-bar { background: var(--wac-accent); }
.wolfpack-agent-context .wac-clear { color: var(--wac-muted); font-size: 11px; }
.wolfpack-agent-context .wac-blockers h3 { color: var(--warning, #ebca78); }
.wolfpack-agent-context .wac-tools { display: grid; border-top: 1px solid var(--wac-border); }
.wolfpack-agent-context .wac-tool > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; color: var(--wac-muted); font-size: 12px; }
.wolfpack-agent-context .wac-tool > summary:hover { color: var(--wac-text); }
.wolfpack-agent-context .wac-tool-body { display: grid; gap: 10px; padding-bottom: 12px; color: var(--wac-muted); font-size: 11px; }
.wolfpack-agent-context .wac-session-id { font: 11px/1.6 var(--font-mono, monospace); color: var(--text-secondary, #bac6be); user-select: all; }
.wolfpack-agent-context textarea { display: block; width: 100%; min-height: 112px; resize: vertical; padding: 10px; border: 1px solid var(--border-input, #36433b); border-radius: 7px; background: var(--bg-inset, #0d100e); color: var(--wac-text); font: inherit; line-height: 1.6; }
.wolfpack-agent-context textarea::placeholder { color: var(--wac-muted); }
.wolfpack-agent-context .wac-guidance { display: grid; gap: 12px; color: var(--wac-muted); }
.wolfpack-agent-context .wac-request { display: block; padding: 12px; border: 1px solid var(--wac-border); border-radius: 7px; color: var(--wac-text); background: var(--wac-bg); user-select: all; }
.wolfpack-agent-context .wac-button { justify-self: start; min-height: 44px; padding: 7px 12px; border: 1px solid var(--border-hover, #405047); border-radius: 6px; color: var(--wac-text); background: var(--wac-bg); font: inherit; cursor: pointer; }
.wolfpack-agent-context .wac-button:hover { border-color: var(--wac-accent); }
.wolfpack-agent-context .wac-feedback { font-size: 11px; color: var(--wac-muted); }
.wolfpack-agent-context .wac-feedback:empty { display: none; }
@container (min-width: 560px) {
  .wolfpack-agent-context .wac-content { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
  .wolfpack-agent-context .wac-goal { padding: 20px; }
  .wolfpack-agent-context h2 { font-size: 21px; }
}
@media (max-width: 768px) { .wolfpack-agent-context textarea { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { .wolfpack-agent-context .wac-chevron { transition: none; } }
`;

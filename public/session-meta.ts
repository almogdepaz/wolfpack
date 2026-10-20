import { esc } from "../src/html-escape";

/** Display-only footer projection. Never a source of runtime status. */
export interface SessionMeta {
  readonly model?: string;
  readonly reasoning?: string;
  readonly contextPct?: number;
  readonly contextLimit?: number;
  readonly cost?: number;
  readonly costTag?: string;
}

export function sessionMetaHtml(session: { readonly meta?: SessionMeta; readonly footer?: string }): string {
  const { meta, footer } = session;
  if (!meta) return footer ? `<span class="session-meta-footer">${esc(footer)}</span>` : "";
  const fields: string[] = [];
  const model = [meta.model, meta.reasoning].filter(Boolean).join(" · ");
  if (model) fields.push(`<span class="session-meta-model">${esc(model)}</span>`);
  if (meta.contextPct !== undefined) {
    const limit = meta.contextLimit === undefined ? "" : ` (${meta.contextLimit / 1000}k limit)`;
    fields.push(`<span class="session-meta-context${meta.contextPct >= 85 ? " high" : ""}">ctx ${esc(String(meta.contextPct))}%${esc(limit)}</span>`);
  }
  if (meta.cost !== undefined) {
    fields.push(`<span class="session-meta-cost">$${esc(meta.cost.toFixed(3))}${meta.costTag ? ` (${esc(meta.costTag)})` : ""}</span>`);
  }
  return fields.join(' <span aria-hidden="true">·</span> ');
}

/** Display-only footer projection. Never a source of runtime status. */
export interface SessionMeta {
  readonly model?: string;
  readonly reasoning?: string;
  readonly contextPct?: number;
  readonly contextLimit?: number;
  readonly cost?: number;
  readonly costTag?: string;
}

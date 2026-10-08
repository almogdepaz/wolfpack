export type CoalesceDecision = "send_now" | "buffer" | "buffer_until_ack" | "flush_then_buffer" | "flush_then_send";

export interface OutputCoalescingInput {
  readonly queuedBytes: number;
  readonly nextBytes: number;
  readonly sinceLastSendMs: number;
  readonly maxBytes: number;
  readonly smallChunkBytes: number;
  readonly idleMs: number;
  /** Omitted for legacy peers without an application-level output window. */
  readonly availableBytes?: number;
}

export function decideOutputCoalescing(input: OutputCoalescingInput): CoalesceDecision {
  if (input.availableBytes !== undefined) {
    if (input.availableBytes === 0) return "buffer_until_ack";
    if (input.queuedBytes + input.nextBytes > input.availableBytes) return "flush_then_send";
  }
  if (input.nextBytes >= input.maxBytes) return "flush_then_send";
  if (input.queuedBytes + input.nextBytes >= input.maxBytes) return "flush_then_buffer";
  if (input.queuedBytes === 0 && input.nextBytes <= input.smallChunkBytes && input.sinceLastSendMs >= input.idleMs) {
    return "send_now";
  }
  return "buffer";
}

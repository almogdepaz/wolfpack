export type CoalesceDecision = "send_now" | "buffer" | "flush_then_buffer" | "flush_then_send";

export interface OutputCoalescingInput {
  readonly queuedBytes: number;
  readonly nextBytes: number;
  readonly sinceLastSendMs: number;
  readonly maxBytes: number;
  readonly smallChunkBytes: number;
  readonly idleMs: number;
}

export function decideOutputCoalescing(input: OutputCoalescingInput): CoalesceDecision {
  if (input.nextBytes >= input.maxBytes) return "flush_then_send";
  if (input.queuedBytes + input.nextBytes >= input.maxBytes) return "flush_then_buffer";
  if (input.queuedBytes === 0 && input.nextBytes <= input.smallChunkBytes && input.sinceLastSendMs >= input.idleMs) {
    return "send_now";
  }
  return "buffer";
}

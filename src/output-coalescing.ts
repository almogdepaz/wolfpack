export interface CoalescedOutputFlushInput {
  readonly queuedBytes: number;
  readonly nextBytes: number;
  readonly maxBytes: number;
  readonly heldMs: number;
  readonly hardMs: number;
}

export function shouldFlushCoalescedOutput(input: CoalescedOutputFlushInput): boolean {
  return input.heldMs >= input.hardMs || input.queuedBytes + input.nextBytes >= input.maxBytes;
}

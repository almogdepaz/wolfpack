export interface AttachAckState {
  readonly ackReceived: boolean;
  readonly awaitingAck: boolean;
}

/** True only when the compatibility timer still belongs to an unanswered attach. */
export function shouldUseAttachAckFallback(state: AttachAckState): boolean {
  return !state.ackReceived && state.awaitingAck;
}

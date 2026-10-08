export const PTY_ATTACH_CAPABILITY = {
  ORDERED_RESIZE_ACK: "ordered-resize-ack",
} as const;

export const PTY_ATTACH_CAPABILITIES = Object.values(PTY_ATTACH_CAPABILITY);

export const PTY_LIVENESS_MESSAGE = { PING: "ping", PONG: "pong" } as const;
export type PtyLivenessMessage = { readonly type: typeof PTY_LIVENESS_MESSAGE[keyof typeof PTY_LIVENESS_MESSAGE] };

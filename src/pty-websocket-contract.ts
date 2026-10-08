export const PTY_ATTACH_CAPABILITY = {
  ORDERED_RESIZE_ACK: "ordered-resize-ack",
  OUTPUT_ACK: "output-ack",
} as const;

export const PTY_ATTACH_CAPABILITIES = Object.values(PTY_ATTACH_CAPABILITY);

export const PTY_LIVENESS_MESSAGE = { PING: "ping", PONG: "pong" } as const;
export type PtyLivenessMessage = { readonly type: typeof PTY_LIVENESS_MESSAGE[keyof typeof PTY_LIVENESS_MESSAGE] };

// Progress acks have independent admission; ordinary controls cannot drop
// indispensable window credit. Low-volume output still acknowledges promptly.
export const ACK_EVERY_BYTES = 64 * 1024;
export const ACK_MAX_DELAY_MS = 50;
export const VIEWER_WINDOW_BYTES = 512 * 1024;
export const MAX_VIEWER_PENDING_BYTES = 1024 * 1024;
export const ACK_RETRY_DELAY_MS = 250;
export const ACK_RETRY_MAX_ATTEMPTS = 4;
export const EXIT_DRAIN_TIMEOUT_MS = 5000;

export interface PtyOutputAck {
  readonly type: "ack";
  /** Cumulative binary output bytes received on this websocket; safe integer. */
  readonly bytes: number;
}

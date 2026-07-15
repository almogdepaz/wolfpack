export const TAKE_CONTROL_FALLBACK_MS = 3_000;

interface TakeControlTransport {
  readonly isConnected: boolean;
  connect(options: { readonly takeControl: true }): void;
  reconnect(options: { readonly takeControl: true }): void;
}

interface TakeControlFallbackOptions {
  readonly getTransport: () => TakeControlTransport | null;
  readonly isPending: () => boolean;
  readonly prepareRetry: () => void;
}

/** Reconnect with takeover authority when an in-band take_control stalls. */
export function scheduleTakeControlFallback(options: TakeControlFallbackOptions): number {
  return window.setTimeout(() => {
    if (!options.isPending()) return;
    const transport = options.getTransport();
    if (!transport) return;
    options.prepareRetry();
    if (transport.isConnected) {
      transport.reconnect({ takeControl: true });
    } else {
      transport.connect({ takeControl: true });
    }
  }, TAKE_CONTROL_FALLBACK_MS);
}

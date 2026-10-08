export const MOBILE_FOREGROUND_PROBE_MS = 400;
// Longer suspensions warrant a fresh snapshot even if TCP still answers.
export const MOBILE_STALE_THRESHOLD_MS = 30_000;

export function mobileForegroundAction(socketOpen: boolean, hiddenDurationMs: number): "probe" | "reconnect" {
  return socketOpen && hiddenDurationMs < MOBILE_STALE_THRESHOLD_MS ? "probe" : "reconnect";
}

interface ForegroundClient {
  readonly ws: unknown;
  probe(epoch?: number): Promise<boolean>;
}
interface ForegroundController {
  readonly ptyClient: ForegroundClient | null;
  readonly isConnected: boolean;
  forceRepaint(): void;
  resetRetry(): void;
  reconnect(): void;
}

/** Shared production orchestration; environment keeps DOM ownership at the caller. */
export async function resumeMobileTerminal(
  controller: ForegroundController,
  hiddenDuration: number,
  environment: { readonly isVisible: () => boolean; readonly visibilityEpoch: () => number },
): Promise<void> {
  const epoch = environment.visibilityEpoch();
  const client = controller.ptyClient;
  if (mobileForegroundAction(controller.isConnected, hiddenDuration) === "probe" && client) {
    const socket = client.ws;
    const alive = await client.probe(epoch);
    if (environment.visibilityEpoch() !== epoch || !environment.isVisible()
      || controller.ptyClient !== client || client.ws !== socket) return;
    if (alive) { controller.forceRepaint(); return; }
  }
  controller.resetRetry();
  controller.reconnect();
}

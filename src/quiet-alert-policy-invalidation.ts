import { QUIET_ALERT_KIND, type QuietAlertKind } from "./quiet-alert-policy.js";

type QuietAlertPolicyInvalidationListener = (kind?: typeof QUIET_ALERT_KIND.QUIET) => void;

let epoch = 0;
let needsInputEpoch = 0;
const listeners = new Set<QuietAlertPolicyInvalidationListener>();

/** Global capture fence, or the latest invalidation of a particular alert kind. */
export function quietAlertPolicyEpoch(kind?: QuietAlertKind): number {
  return kind === QUIET_ALERT_KIND.NEEDS_INPUT ? needsInputEpoch : epoch;
}

/** Without a kind, retires all local work (disabled); quiet-only keeps needs-input. */
export function invalidateQuietAlertPolicy(kind?: typeof QUIET_ALERT_KIND.QUIET): void {
  epoch += 1;
  if (kind !== QUIET_ALERT_KIND.QUIET) needsInputEpoch = epoch;
  for (const listener of listeners) listener(kind);
}

export function onQuietAlertPolicyInvalidation(listener: QuietAlertPolicyInvalidationListener): void {
  listeners.add(listener);
}

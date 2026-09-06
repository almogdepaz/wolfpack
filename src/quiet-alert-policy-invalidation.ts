type QuietAlertPolicyInvalidationListener = () => void;

let epoch = 0;
const listeners = new Set<QuietAlertPolicyInvalidationListener>();

/** Returns a generation that retires captures created before quiet alerts were disabled. */
export function quietAlertPolicyEpoch(): number {
  return epoch;
}

/** Retires pending quiet episodes and delivery ownership when alerts are disabled. */
export function invalidateQuietAlertPolicy(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

export function onQuietAlertPolicyInvalidation(listener: QuietAlertPolicyInvalidationListener): void {
  listeners.add(listener);
}

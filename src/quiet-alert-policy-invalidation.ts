type QuietAlertPolicyInvalidationListener = () => void;

let epoch = 0;
const listeners = new Set<QuietAlertPolicyInvalidationListener>();

/** Returns a generation that retires local captures made before a restrictive policy change. */
export function quietAlertPolicyEpoch(): number {
  return epoch;
}

/** Retires local quiet episodes and delivery ownership when policy becomes more restrictive. */
export function invalidateQuietAlertPolicy(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

export function onQuietAlertPolicyInvalidation(listener: QuietAlertPolicyInvalidationListener): void {
  listeners.add(listener);
}

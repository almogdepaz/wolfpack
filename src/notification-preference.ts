export interface NotificationPreferenceChange {
  readonly current: boolean;
  readonly requested: boolean;
  readonly changeSubscription: () => Promise<boolean>;
  readonly commit: (enabled: boolean) => void;
}

export async function applyNotificationPreference(
  change: NotificationPreferenceChange,
): Promise<boolean> {
  const changed = await change.changeSubscription();
  const enabled = changed ? change.requested : change.current;
  change.commit(enabled);
  return enabled;
}

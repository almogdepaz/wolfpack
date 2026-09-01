type SubSessionOpenedNotifier = (parentSession: string, session: string) => boolean;

let subSessionOpenedNotifier: SubSessionOpenedNotifier | null = null;

export function registerSubSessionOpenedNotifier(notifier: SubSessionOpenedNotifier): void {
  subSessionOpenedNotifier = notifier;
}

export function notifySubSessionOpened(parentSession: string, session: string): boolean {
  return subSessionOpenedNotifier?.(parentSession, session) ?? false;
}

export function __resetSessionNotificationsForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetSessionNotificationsForTests() is test-only");
  subSessionOpenedNotifier = null;
}

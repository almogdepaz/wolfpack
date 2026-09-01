type SubSessionOpenedNotifier = (parentSession: string, session: string) => boolean;

let subSessionOpenedNotifier: SubSessionOpenedNotifier | null = null;

export function registerSubSessionOpenedNotifier(notifier: SubSessionOpenedNotifier): void {
  subSessionOpenedNotifier = notifier;
}

export function notifySubSessionOpened(parentSession: string, session: string): boolean {
  return subSessionOpenedNotifier?.(parentSession, session) ?? false;
}

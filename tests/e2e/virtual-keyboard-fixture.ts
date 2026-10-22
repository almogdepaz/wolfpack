import type { Page } from '@playwright/test';

// Replace only the native browser API. Layout, input, and terminal ownership
// remain production code driven by native EventTarget/DOMRect geometry events.
interface NativeKeyboardFixture extends EventTarget {
  overlaysContent: boolean;
  boundingRect: DOMRect;
  readonly overlayHistory: boolean[];
  readonly listeners: Set<EventListenerOrEventListenerObject | null>;
  geometry(top: number, height: number): void;
}
declare global {
  interface Window {
    __nativeKeyboard: NativeKeyboardFixture;
    __nativeCanvas?: Element | null;
  }
}
export type NativeKeyboardWindow = Window;

export async function installNativeKeyboard(page: Page, previous: boolean, policy: 'allow' | 'ignore' | 'throw' = 'allow'): Promise<void> {
  await page.addInitScript(({ previous, policy }) => {
    class Keyboard extends EventTarget {
      private overlay = previous;
      boundingRect = new DOMRect();
      readonly overlayHistory: boolean[] = [];
      readonly listeners = new Set<EventListenerOrEventListenerObject | null>();
      get overlaysContent(): boolean { return this.overlay; }
      set overlaysContent(value: boolean) {
        this.overlayHistory.push(value);
        if (policy === 'throw') throw new DOMException('fixture policy refused overlay', 'NotSupportedError');
        if (policy !== 'ignore') this.overlay = value;
      }
      override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
        if (type === 'geometrychange') this.listeners.add(listener);
        super.addEventListener(type, listener, options);
      }
      override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
        if (type === 'geometrychange') this.listeners.delete(listener);
        super.removeEventListener(type, listener, options);
      }
      geometry(top: number, height: number): void {
        this.boundingRect = height ? new DOMRect(0, top, innerWidth, height) : new DOMRect();
        this.dispatchEvent(new Event('geometrychange'));
      }
    }
    const keyboard = new Keyboard();
    Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: keyboard });
    Object.assign(window, { __nativeKeyboard: keyboard });
  }, { previous, policy });
}

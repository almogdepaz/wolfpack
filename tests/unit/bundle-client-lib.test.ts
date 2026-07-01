import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "bun:test";

interface MessageInputEnterEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly enterSends: boolean;
  readonly isDesktop: boolean;
}

type MessageInputEnterHandler = (event: MessageInputEnterEvent) => boolean;

interface BundleWp {
  readonly shouldSubmitMessageInputOnEnter?: MessageInputEnterHandler;
}

interface BundleContext {
  readonly window: {
    WP?: BundleWp;
  };
}

describe("wolfpack-lib browser bundle", () => {
  test("exports message input Enter helper on window.WP", () => {
    const context: BundleContext = { window: {} };
    const bundlePath = resolve(import.meta.dirname, "../../public/wolfpack-lib.js");

    runInNewContext(readFileSync(bundlePath, "utf8"), context);

    const helper = context.window.WP?.shouldSubmitMessageInputOnEnter;
    expect(typeof helper).toBe("function");
    if (!helper) throw new Error("missing window.WP.shouldSubmitMessageInputOnEnter");

    expect(helper({ key: "Enter", shiftKey: false, enterSends: true, isDesktop: false })).toBe(false);
    expect(helper({ key: "Enter", shiftKey: false, enterSends: true, isDesktop: true })).toBe(true);
  });
});

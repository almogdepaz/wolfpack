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

type AccessoryEnterHandler = (event: { readonly key: string; readonly isMessageInputActive: boolean }) => boolean;

interface BundleWp {
  readonly shouldInsertMessageNewlineFromAccessoryKey?: AccessoryEnterHandler;
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
    const accessoryHelper = context.window.WP?.shouldInsertMessageNewlineFromAccessoryKey;
    expect(typeof helper).toBe("function");
    expect(typeof accessoryHelper).toBe("function");
    if (!helper) throw new Error("missing window.WP.shouldSubmitMessageInputOnEnter");
    if (!accessoryHelper) throw new Error("missing window.WP.shouldInsertMessageNewlineFromAccessoryKey");

    expect(helper({ key: "Enter", shiftKey: false, enterSends: true, isDesktop: false })).toBe(true);
    expect(helper({ key: "Enter", shiftKey: false, enterSends: true, isDesktop: true })).toBe(true);
    expect(accessoryHelper({ key: "Enter", isMessageInputActive: true })).toBe(true);
    expect(accessoryHelper({ key: "Enter", isMessageInputActive: false })).toBe(false);
  });
});

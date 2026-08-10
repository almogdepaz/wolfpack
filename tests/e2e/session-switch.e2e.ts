/**
 * Session switch — open drawer, switch between sessions, verify terminal updates.
 *
 * Uses mobile viewport which routes through /ws/pty unified terminal path.
 */
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";
import { CLOSE_CODE_PREFILL_TIMEOUT, WS_CLOSE_REASONS } from "../../src/ws-constants.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

test("open session drawer from terminal view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only viewport tests");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Navigate into a session first (drawer chip only shows in terminal view)
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();
  await expect(page.locator("#terminal-view")).toBeVisible();

  // Chip should display current session name
  const chip = page.locator("#session-chip");
  await expect(chip).toBeVisible();
  await expect(page.locator("#chip-label")).toHaveText("test-project");

  // Click chip to open drawer
  await chip.click();

  const drawer = page.locator("#session-drawer");
  await expect(drawer).toHaveClass(/open/);
});

test("mobile drawer session tap includes the exact touch-slop boundary", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only viewport tests");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await page.locator("#session-chip").click();

  const item = page.locator('.drawer-item[data-val="another-project"]');
  await expect(item).toBeVisible();
  await item.evaluate((target) => {
    const dispatchTouch = (type: string, clientY: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [{ clientX: 100, clientY }],
      });
      Object.defineProperty(event, "changedTouches", {
        value: [{ clientX: 100, clientY }],
      });
      target.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 220);
    dispatchTouch("touchmove", 205);
    dispatchTouch("touchend", 205);
  });

  await expect(page.locator("#chip-label")).toHaveText("another-project");
  await expect(page.locator("#session-drawer")).not.toHaveClass(/open/);
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
});

test("mobile keyboard viewport shift does not take over terminal view transform", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only keyboard viewport path");

  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("keyboard-test\r\n"));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    const listeners: Array<() => void> = [];
    const fakeVisualViewport = {
      height: 844,
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: () => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(window, "visualViewport", { value: fakeVisualViewport, configurable: true });
    (window as unknown as { __setFakeKeyboardHeight: (height: number) => void }).__setFakeKeyboardHeight = (height: number): void => {
      fakeVisualViewport.height = 844 - height;
      for (const listener of listeners) listener();
    };
  });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  const state = await page.evaluate(() => {
    const terminalView = document.getElementById("terminal-view")!;
    const terminalViewBefore = terminalView.style.transform;
    (window as unknown as { __setFakeKeyboardHeight: (height: number) => void }).__setFakeKeyboardHeight(320);
    const terminalContainer = document.getElementById("desktop-terminal-container")!;
    const accessory = document.getElementById("kb-accessory")!;
    const appState = (window as unknown as {
      state: { kbAccessoryOpen: boolean; terminalController?: { term?: { options: { disableStdin: boolean } } } };
    }).state;
    return {
      terminalViewBefore,
      terminalViewInlineTransform: terminalView.style.transform,
      terminalContainerInlineTransform: terminalContainer.style.transform,
      accessoryDisplay: getComputedStyle(accessory).display,
      accessoryInlineTransform: accessory.style.transform,
      keyboardStateOpen: appState.kbAccessoryOpen,
      stdinDisabled: appState.terminalController?.term?.options.disableStdin,
    };
  });

  expect(state.terminalViewInlineTransform).toBe(state.terminalViewBefore);
  expect(state.terminalContainerInlineTransform).toBe("translateY(-320px)");
  expect(state.accessoryDisplay).toBe("flex");
  expect(state.accessoryInlineTransform).toBe("translateY(-320px)");
  expect(state.keyboardStateOpen).toBe(false);
  expect(state.stdinDisabled).toBe(true);
});

test("mobile terminal mount does not horizontally scroll the view container", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only terminal mount path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await expect.poll(() => page.evaluate(() => ({
    viewScrollLeft: document.getElementById("view-container")?.scrollLeft ?? -1,
    terminalLeft: Math.round(document.getElementById("terminal-view")?.getBoundingClientRect().left ?? -1),
  }))).toEqual({ viewScrollLeft: 0, terminalLeft: 0 });
});

test("mobile keyboard uses ghostty native input with explicit open and close", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only ghostty keyboard path");

  const sentFrames: string[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") {
        sentFrames.push(Buffer.from(message).toString("utf8"));
        return;
      }
      let parsed: { readonly type?: string; readonly prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await expect(page.locator("#mobile-kb-proxy")).toHaveCount(0);
  const nativeInput = page.locator("#desktop-terminal-container textarea");
  await expect(nativeInput).toHaveCount(1);
  await expect(nativeInput).toHaveAttribute("readonly", "");
  await expect(nativeInput).toHaveAttribute("inputmode", "none");
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.terminalController?.term?.options.disableStdin;
  })).toBe(true);

  await page.locator("#kb-open-btn").click();
  await expect(nativeInput).not.toHaveAttribute("readonly", "");
  await expect(nativeInput).toHaveAttribute("inputmode", "text");
  await expect.poll(() => page.evaluate(() => document.activeElement === document.querySelector("#desktop-terminal-container textarea"))).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.terminalController?.term?.options.disableStdin;
  })).toBe(false);

  await nativeInput.evaluate((textarea) => {
    textarea.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "a",
      inputType: "insertText",
    }));
  });
  await expect.poll(() => sentFrames).toEqual(["a"]);
  sentFrames.length = 0;

  await nativeInput.evaluate((textarea) => {
    textarea.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "pasted text",
      inputType: "insertFromPaste",
    }));
  });
  await expect.poll(() => sentFrames).toEqual(["pasted text"]);
  sentFrames.length = 0;

  await nativeInput.evaluate((textarea) => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "b",
      code: "KeyB",
    }));
    textarea.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "b",
      inputType: "insertText",
    }));
  });
  await expect.poll(() => sentFrames).toEqual(["b"]);
  sentFrames.length = 0;

  await nativeInput.evaluate((textarea) => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    textarea.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "你好",
      inputType: "insertText",
    }));
    textarea.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: null,
      inputType: "deleteContentBackward",
    }));
  });
  await expect.poll(() => sentFrames.join(""), { timeout: 5000 }).toBe("你好\x7f");

  await page.locator("#kb-open-btn").click();
  await expect(nativeInput).toHaveAttribute("readonly", "");
  await expect(nativeInput).toHaveAttribute("inputmode", "none");
  await expect.poll(() => page.evaluate(() => document.activeElement === document.querySelector("#desktop-terminal-container textarea"))).toBe(false);
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    return state.terminalController?.term?.options.disableStdin;
  })).toBe(true);
});

test("mobile card swipe opens the selected terminal without exposing fallback input during peek", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only swipe path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  const state = await page.evaluate(() => {
    const card = document.querySelector(".card") as HTMLElement | null;
    if (!card) throw new Error("missing session card");
    const dispatchTouch = (type: string, clientX: number, clientY: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [{ clientX, clientY }],
      });
      card.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 350, 220);
    dispatchTouch("touchmove", 40, 222);
    const terminalView = document.getElementById("terminal-view");
    const inputBar = document.getElementById("input-bar");
    const accessory = document.getElementById("kb-accessory");
    const peek = {
      terminalVisible: terminalView?.classList.contains("visible") ?? false,
      terminalTransform: terminalView ? getComputedStyle(terminalView).transform : "",
      inputBarDisplay: inputBar ? getComputedStyle(inputBar).display : "missing",
      accessoryDisplay: accessory ? getComputedStyle(accessory).display : "missing",
      accessoryVisible: accessory?.classList.contains("visible") ?? false,
    };
    const expectedSession = card.querySelector(".card-name")?.firstChild?.textContent ?? "";
    dispatchTouch("touchend", 40, 222);
    return {
      ...peek,
      expectedSession,
      selectedSession: (window as unknown as { state: { currentSession: string | null } }).state.currentSession,
    };
  });

  expect(state.terminalVisible).toBe(true);
  expect(state.terminalTransform).not.toBe("none");
  expect(state.inputBarDisplay).toBe("none");
  expect(state.accessoryDisplay).toBe("none");
  expect(state.accessoryVisible).toBe(false);
  expect(state.expectedSession).not.toBe("");
  expect(state.selectedSession).toBe(state.expectedSession);
});

test("mobile touch scrolling dismisses an open native keyboard after drag threshold", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only touch path");

  const attachModes: string[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      const prefillMode = parsed.prefillMode || "full";
      attachModes.push(prefillMode);
      const lineCount = prefillMode === "full" ? 120 : 12;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from({ length: lineCount }, (_, index) => `history-${index}\r\n`).join("")));
      if (prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await expect.poll(() => attachModes).toEqual(["full", "full"]);
  await expect.poll(() => page.evaluate(() => {
    const terminal = (window as unknown as { state: { terminalController?: { term?: { getScrollbackLength?: () => number } } } }).state.terminalController?.term;
    return terminal?.getScrollbackLength?.() ?? 0;
  })).toBeGreaterThan(0);

  await page.locator("#kb-open-btn").click();
  const nativeInput = page.locator("#desktop-terminal-container textarea");
  await expect(nativeInput).toBeFocused();

  const dragState = await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const textarea = container?.querySelector("textarea") as HTMLTextAreaElement | null;
    const terminal = (window as unknown as { state: { terminalController?: { term?: { viewportY: number; options: { disableStdin: boolean } } } } }).state.terminalController?.term;
    if (!container || !canvas || !textarea || !terminal) throw new Error("missing mobile terminal");
    const dispatchTouch = (type: string, clientY: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [{ clientX: 100, clientY }],
      });
      canvas.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 300);
    const focusedAfterStart = document.activeElement === textarea;
    dispatchTouch("touchmove", 500);
    const focusedAfterMove = document.activeElement === textarea;
    dispatchTouch("touchend", 500);
    return {
      focusedAfterStart,
      focusedAfterMove,
      focusedAfterEnd: document.activeElement === textarea,
      inputMode: textarea.getAttribute("inputmode"),
      readOnly: textarea.readOnly,
      stdinDisabled: terminal.options.disableStdin,
      viewportY: terminal.viewportY,
    };
  });

  expect(dragState.focusedAfterStart).toBe(true);
  expect(dragState.focusedAfterMove).toBe(false);
  expect(dragState.focusedAfterEnd).toBe(false);
  expect(dragState.inputMode).toBe("none");
  expect(dragState.readOnly).toBe(true);
  expect(dragState.stdinDisabled).toBe(true);
  expect(dragState.viewportY).toBeGreaterThan(0);
});

test("full session switch and reconnect keep partial prefill hidden until prefill_done", async ({ page }) => {
  let switchedPrefillMode = "";
  let switchedFullAttachCount = 0;
  let latestFullPrefillDone = true;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session");
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      const prefillMode = parsed.prefillMode || "full";
      ws.send(JSON.stringify({ type: "attach_ack" }));
      if (session === "test-project") {
        ws.send(Buffer.from("INITIAL-SESSION\r\n"));
        if (prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }

      switchedPrefillMode = prefillMode;
      if (prefillMode === "viewport") {
        ws.send(Buffer.from("SWITCHED-VIEWPORT\r\n"));
        ws.send(JSON.stringify({ type: "prefill_viewport" }));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }

      switchedFullAttachCount++;
      latestFullPrefillDone = false;
      ws.send(Buffer.from("SWITCHED-PARTIAL-1\r\n"));
      setTimeout(() => ws.send(Buffer.from("SWITCHED-PARTIAL-2\r\n")), 2500);
      setTimeout(() => {
        latestFullPrefillDone = true;
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      }, 5000);
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => localStorage.setItem("wolfpackDebug", "1"));
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    const debugWindow = window as unknown as {
      __fullPrefillEarlyReveal?: boolean;
      __wfTrace?: Record<string, {
        readonly _meta: { readonly session: string };
        readonly events: ReadonlyArray<{ readonly kind: string; readonly prefillMode?: string }>;
      }>;
    };
    debugWindow.__fullPrefillEarlyReveal = false;
    const observe = (): void => {
      const trace = Object.values(debugWindow.__wfTrace || {}).find(candidate => candidate._meta.session === "another-project");
      const fullPrefill = trace?.events.some(event => event.kind === "attach.send" && event.prefillMode === "full") ?? false;
      const prefillDone = trace?.events.some(event => event.kind === "prefill_done") ?? false;
      const canvas = document.querySelector("#desktop-terminal-container canvas");
      const style = canvas ? getComputedStyle(canvas) : null;
      if (fullPrefill && !prefillDone && style?.visibility === "visible" && style.opacity === "1") {
        debugWindow.__fullPrefillEarlyReveal = true;
      }
      if (!prefillDone) requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
  });

  await expect.poll(() => switchedPrefillMode).not.toBe("");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 7000 });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { __fullPrefillEarlyReveal?: boolean }).__fullPrefillEarlyReveal)).toBe(false);

  if (switchedPrefillMode !== "full") return;
  await page.evaluate(() => {
    const controller = (window as unknown as { state: { terminalController?: { reconnect(): void } } }).state.terminalController;
    if (!controller) throw new Error("missing terminal controller");
    controller.reconnect();
  });
  await expect.poll(() => switchedFullAttachCount).toBe(2);
  await page.waitForTimeout(4200);
  expect(latestFullPrefillDone).toBe(false);
  const reconnectVisualState = await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const style = canvas ? getComputedStyle(canvas) : null;
    return {
      loadState: container?.getAttribute("data-terminal-load-state") || "",
      visibility: style?.visibility || "missing",
      opacity: style?.opacity || "missing",
    };
  });
  expect(reconnectVisualState).toEqual({
    loadState: "hydrating",
    visibility: "hidden",
    opacity: "0",
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 3000 });
});

test("viewer conflict force-finishes hydration without prefill completion", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only conflict overlay path");

  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string };
      if (parsed.type === "attach") ws.send(JSON.stringify({ type: "viewer_conflict" }));
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect(page.locator("#desktop-conflict-overlay")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const controller = (window as unknown as {
      state: { terminalController?: { hydration?: { readonly pending: boolean } } };
    }).state.terminalController;
    return controller?.hydration?.pending ?? null;
  })).toBe(false);
});

test("single take-control retries with takeover attach when control_granted stalls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only conflict overlay path");

  const attaches: Array<{ readonly takeControl?: boolean }> = [];
  let takeControlMessages = 0;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly takeControl?: boolean };
      if (parsed.type === "attach") {
        attaches.push({ takeControl: parsed.takeControl });
        if (!parsed.takeControl) ws.send(JSON.stringify({ type: "viewer_conflict" }));
      } else if (parsed.type === "take_control") {
        takeControlMessages++;
      }
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.clock.install();

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-conflict-overlay")).toBeVisible();
  await page.locator("#desktop-conflict-overlay button").click();
  await expect.poll(() => takeControlMessages).toBe(1);

  await page.clock.fastForward(3_100);
  await expect.poll(() => attaches.some(({ takeControl }) => takeControl === true)).toBe(true);
});

test("full prefill timeout closes the stalled socket instead of revealing partial content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one browser profile covers the socket deadline");

  const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
  let observedAttachPrefillMode: string | undefined;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      observedAttachPrefillMode = parsed.prefillMode;
      expect(parsed.prefillMode).toBe("full");
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("PARTIAL-PREFILL-WITHOUT-DONE\r\n"));
    });
    ws.onClose((code, reason) => {
      closes.push({ code, reason });
      void ws.close({ code, reason });
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.clock.install();

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "prefill-loading");
  await expect.poll(() => observedAttachPrefillMode).toBe("full");

  await page.clock.fastForward(16_000);
  await expect.poll(() => closes).toContainEqual({
    code: CLOSE_CODE_PREFILL_TIMEOUT,
    reason: WS_CLOSE_REASONS.PREFILL_TIMEOUT,
  });
  const visualState = await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const style = canvas ? getComputedStyle(canvas) : null;
    return {
      visibility: style?.visibility || "missing",
      opacity: style?.opacity || "missing",
    };
  });
  expect(visualState).toEqual({ visibility: "hidden", opacity: "0" });
});

test("desktop full switchSession keeps cached snapshot hidden until hydration", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    localStorage.setItem(
      "wp-snap||another-project",
      JSON.stringify({ d: "cached-another-session", ts: Date.now() }),
    );
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#terminal-view")).toBeVisible();

  const immediateState = await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
    const container = document.getElementById("desktop-terminal-container");
    return {
      className: container?.className || "",
      placeholder: container?.querySelector(".cached-terminal-placeholder")?.textContent ?? "",
      loadState: container?.getAttribute("data-terminal-load-state") || "",
    };
  });

  expect(immediateState.className).not.toContain("cached-visible");
  expect(immediateState.placeholder).toBe("");
  expect(immediateState.loadState).toBe("prefill-loading");
});

async function expectSoloAttachPrefillMode(page: import("@playwright/test").Page, mode: "viewport" | "full") {
  await expect.poll(async () => page.evaluate((expectedMode) => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; prefillMode?: string }> }>;
    };
    return Object.values(debugWindow.__wfTrace || {}).some((trace) =>
      trace._meta.session === "test-project" &&
      trace.events.some((event) => event.kind === "attach.send" && event.prefillMode === expectedMode),
    );
  }, mode), { timeout: 5000 }).toBe(true);
}

test("desktop solo full prefill clears cached prose", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-snap||test-project", JSON.stringify({ d: "CACHED-HISTORY-MUST-NOT-MIX\n".repeat(60), ts: Date.now() }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    const controller = (window as unknown as { state: { terminalController?: { term?: { buffer?: { active?: unknown } } } } }).state.terminalController;
    const buffer = controller?.term?.buffer?.active;
    if (!buffer) return "";
    return (window as unknown as { WP: { serializeBufferTail(buffer: unknown, maxLines: number): string } }).WP.serializeBufferTail(buffer, 80);
  }), { timeout: 5000 }).toContain("FULL-PREFILL");

  const tail = await page.evaluate(() => {
    const buffer = (window as unknown as { state: { terminalController?: { term?: { buffer?: { active?: unknown } } } } }).state.terminalController?.term?.buffer?.active;
    return buffer ? (window as unknown as { WP: { serializeBufferTail(buffer: unknown, maxLines: number): string } }).WP.serializeBufferTail(buffer, 80) : "";
  });
  expect(tail).not.toContain("CACHED-HISTORY-MUST-NOT-MIX");
});

test("mobile first-session restore uses full prefill without showing cached placeholder", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only restore path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-snap||test-project", JSON.stringify({ d: "MOBILE-CACHED-PROSE\n".repeat(60), ts: Date.now() }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  const immediateState = await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
    const container = document.getElementById("desktop-terminal-container");
    return {
      className: container?.className || "",
      placeholder: container?.querySelector(".cached-terminal-placeholder")?.textContent || "",
      loadState: container?.getAttribute("data-terminal-load-state") || "",
    };
  });

  expect(immediateState.className).not.toContain("cached-visible");
  expect(immediateState.placeholder).toBe("");
  expect(immediateState.loadState).toBe("prefill-loading");
  await expectSoloAttachPrefillMode(page, "full");
});

test("desktop solo terminal defaults to full prefill", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => localStorage.setItem("wolfpackDebug", "1"));
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expectSoloAttachPrefillMode(page, "full");
});

test("mobile created solo session requests full prefill despite legacy fast setting", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only create path");

  const attachMessages: Array<{ readonly type?: string; readonly prefillMode?: string }> = [];
  await page.route("**/api/create", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: "created-solo" }),
    });
  });
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      attachMessages.push(parsed);
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("created solo\r\n"));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "fast" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    const appState = (window as unknown as { state: { selectedProject: string; isNewProject: boolean } }).state;
    appState.selectedProject = "test-project";
    appState.isNewProject = false;
    const input = document.getElementById("session-name-input") as HTMLInputElement | null;
    if (input) input.value = "created-solo";
    // @ts-ignore exposed by the browser bundle
    void createSessionWithAgent("shell");
  });

  await expect.poll(() => attachMessages.at(-1)?.prefillMode, { timeout: 5000 }).toBe("full");
});

test("settings UI does not expose solo prefill mode", async ({ page }) => {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    showView("settings");
  });

  await expect(page.locator("text=Solo prefill")).toHaveCount(0);
  await expect(page.locator(".solo-prefill-btn")).toHaveCount(0);
});

function mockPrefillWebSocket(mode: "full" | "viewport"): (ws: WebSocketRoute) => void {
  return (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${mode.toUpperCase()}-PREFILL-1\n`));
      setTimeout(() => ws.send(Buffer.from(`${mode.toUpperCase()}-PREFILL-2\n`)), 25);
      if (mode === "viewport") setTimeout(() => ws.send(JSON.stringify({ type: "prefill_viewport" })), 50);
      setTimeout(() => ws.send(JSON.stringify({ type: "prefill_done" })), 100);
      setTimeout(() => ws.send(JSON.stringify({ type: "pty_ready" })), 110);
    });
  };
}

test("terminal renders its final PTY column and sends final-width layout_stable", async ({ page }) => {
  const messages: Array<{ type?: string; cols?: number; rows?: number }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; cols?: number; rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      messages.push(parsed);
      if (parsed.type !== "attach") return;
      const cols = parsed.cols ?? 1;
      const rows = parsed.rows ?? 1;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${"history\r\n".repeat(rows + 1)}\x1b[2J\x1b[H${"X".repeat(cols)}\r\n`));
      setTimeout(() => ws.send(JSON.stringify({ type: "prefill_done" })), 30);
      setTimeout(() => ws.send(JSON.stringify({ type: "pty_ready" })), 40);
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wolfpack-sidebar-pinned", "0");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  const terminalContainer = page.locator("#desktop-terminal-container");
  await expect(terminalContainer).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await expect.poll(() => messages.some((message) => message.type === "layout_stable"), { timeout: 5000 }).toBe(true);
  await page.waitForTimeout(350);

  const stableIndex = messages.findIndex((message) => message.type === "layout_stable");
  const stable = messages[stableIndex];
  const latestSizeMessage = messages
    .slice(0, stableIndex)
    .filter((message) => message.type === "attach" || message.type === "resize")
    .at(-1);
  const finalGeometry = await page.evaluate(() => {
    const appState = (window as unknown as {
      state: { terminalController?: { term?: { cols: number; rows: number; renderer?: { getMetrics?: () => { width: number; height: number } } } } };
    }).state;
    const term = appState.terminalController?.term;
    const canvas = document.querySelector<HTMLCanvasElement>("#desktop-terminal-container canvas");
    const metrics = term?.renderer?.getMetrics?.();
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const pixelRatio = canvas ? canvas.width / canvas.getBoundingClientRect().width : 1;
    const cellInk = (column: number): number => {
      if (!context || !metrics) return 0;
      const pixels = context.getImageData(
        Math.round(column * metrics.width * pixelRatio),
        0,
        Math.round(metrics.width * pixelRatio),
        Math.round(metrics.height * pixelRatio),
      ).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 300) count += 1;
      }
      return count;
    };
    return {
      cols: term?.cols,
      rows: term?.rows,
      cellWidth: metrics?.width,
      canvasWidth: canvas?.getBoundingClientRect().width,
      referenceCellInk: term ? cellInk(term.cols - 3) : 0,
      lastCellInk: term ? cellInk(term.cols - 1) : 0,
    };
  });
  const postStableResizes = messages.slice(stableIndex + 1).filter((message) => message.type === "resize");

  expect(stable).toEqual(expect.objectContaining({ cols: latestSizeMessage?.cols, rows: latestSizeMessage?.rows }));
  expect(stable).toEqual(expect.objectContaining({ cols: finalGeometry.cols, rows: finalGeometry.rows }));
  expect(postStableResizes).toEqual([]);
  expect(finalGeometry.canvasWidth).toBe((finalGeometry.cols ?? 0) * (finalGeometry.cellWidth ?? 0));
  expect(finalGeometry.referenceCellInk).toBeGreaterThan(0);
  expect(finalGeometry.lastCellInk).toBeGreaterThanOrEqual(finalGeometry.referenceCellInk * 0.8);
});

test("debug layout-stable immediate mode sends an early stable signal before attach ack", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  const messages: Array<{ type?: string; cols?: number; rows?: number }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; cols?: number; rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      messages.push(parsed);
      if (parsed.type !== "attach") return;
      setTimeout(() => ws.send(JSON.stringify({ type: "attach_ack" })), 25);
      setTimeout(() => ws.send(Buffer.from("FULL-PREFILL\n")), 30);
      setTimeout(() => ws.send(JSON.stringify({ type: "prefill_done" })), 60);
      setTimeout(() => ws.send(JSON.stringify({ type: "pty_ready" })), 70);
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wolfpackLayoutStableDebugMode", "immediate-and-after-paint");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect.poll(() => messages.filter((message) => message.type === "layout_stable").length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const attachIndex = messages.findIndex((message) => message.type === "attach");
  const firstStableIndex = messages.findIndex((message) => message.type === "layout_stable");
  expect(firstStableIndex).toBe(attachIndex + 1);
  const attach = messages[attachIndex];
  const firstStable = messages[firstStableIndex];
  expect(firstStable).toEqual(expect.objectContaining({ cols: attach?.cols, rows: attach?.rows }));
});

test("debug viewport-only layout-stable mode does not send immediate for desktop full prefill", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  const messages: Array<{ type?: string; cols?: number; rows?: number }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; cols?: number; rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      messages.push(parsed);
      if (parsed.type !== "attach") return;
      setTimeout(() => {
        messages.push({ type: "attach_ack" });
        ws.send(JSON.stringify({ type: "attach_ack" }));
      }, 25);
      setTimeout(() => ws.send(Buffer.from("FULL-PREFILL\n")), 30);
      setTimeout(() => ws.send(JSON.stringify({ type: "prefill_done" })), 60);
      setTimeout(() => ws.send(JSON.stringify({ type: "pty_ready" })), 70);
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wolfpackLayoutStableDebugMode", "viewport-immediate-and-after-paint");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect.poll(() => messages.some((message) => message.type === "layout_stable"), { timeout: 5000 }).toBe(true);
  const ackIndex = messages.findIndex((message) => message.type === "attach_ack");
  const firstStableIndex = messages.findIndex((message) => message.type === "layout_stable");
  expect(ackIndex).toBeGreaterThan(-1);
  expect(firstStableIndex).toBeGreaterThan(ackIndex);
});

test("desktop sidebar hover does not put live terminal into loading state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only sidebar path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  const terminalContainer = page.locator("#desktop-terminal-container");
  await expect(terminalContainer).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await expect.poll(async () => terminalContainer.locator("canvas").evaluate((canvas) => getComputedStyle(canvas).opacity), {
    timeout: 5000,
  }).toBe("1");

  const hoverState = await page.evaluate(() => {
    const stateWindow = window as unknown as { state: { sidebarResizeDone: boolean; sidebarCollapsed: boolean; sidebarPinned: boolean; sessionsExpanded: boolean } };
    stateWindow.state.sidebarResizeDone = false;
    stateWindow.state.sidebarCollapsed = true;
    stateWindow.state.sidebarPinned = false;
    stateWindow.state.sessionsExpanded = false;
    const sidebar = document.getElementById("desktop-sidebar");
    sidebar?.classList.add("collapsed");
    document.body.classList.remove("sidebar-pinned", "sessions-expanded");
    document.getElementById("sidebar-hover-edge")?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const canvasStyle = canvas ? getComputedStyle(canvas) : null;
    return {
      className: container?.className || "",
      loadState: container?.getAttribute("data-terminal-load-state") || "",
      canvasVisibility: canvasStyle?.visibility || "missing",
      canvasOpacity: canvasStyle?.opacity || "missing",
    };
  });

  expect(hoverState.className).not.toContain("transitioning");
  expect(hoverState.loadState).toBe("live");
  expect(hoverState.canvasVisibility).toBe("visible");
  expect(hoverState.canvasOpacity).toBe("1");
});

test("desktop switch hides old canvas before auto-collapsing sidebar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    const stateWindow = window as unknown as { state: { sidebarAutoExpanded: boolean; sidebarCollapsed: boolean } };
    stateWindow.state.sidebarAutoExpanded = true;
    stateWindow.state.sidebarCollapsed = false;
    const sidebar = document.getElementById("desktop-sidebar");
    sidebar?.classList.remove("collapsed");
    const originalAdd = DOMTokenList.prototype.add;
    DOMTokenList.prototype.add = function (...tokens: string[]) {
      if (this === sidebar?.classList && tokens.includes("collapsed")) {
        const container = document.getElementById("desktop-terminal-container");
        const canvas = container?.querySelector("canvas");
        const canvasStyle = canvas ? getComputedStyle(canvas) : null;
        (window as unknown as { __sidebarCollapseVisualState?: unknown }).__sidebarCollapseVisualState = {
          className: container?.className || "",
          loadState: container?.getAttribute("data-terminal-load-state") || "",
          canvasVisibility: canvasStyle?.visibility || "missing",
          canvasOpacity: canvasStyle?.opacity || "missing",
        };
      }
      return originalAdd.apply(this, tokens);
    };
  });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("another-project", "");
  });

  const collapseVisualState = await page.evaluate(() => (window as unknown as { __sidebarCollapseVisualState?: unknown }).__sidebarCollapseVisualState);
  expect(collapseVisualState).toEqual(expect.objectContaining({
    loadState: "prefill-loading",
    canvasVisibility: "hidden",
    canvasOpacity: "0",
  }));
});

test("desktop switch hides old canvas before disposing previous terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    const controller = (window as unknown as { state: { terminalController?: { dispose?: () => void } } }).state.terminalController;
    if (!controller?.dispose) throw new Error("missing terminal controller");
    const originalDispose = controller.dispose.bind(controller);
    controller.dispose = () => {
      const container = document.getElementById("desktop-terminal-container");
      const canvas = container?.querySelector("canvas");
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      (window as unknown as { __disposeVisualState?: unknown }).__disposeVisualState = {
        className: container?.className || "",
        loadState: container?.getAttribute("data-terminal-load-state") || "",
        canvasVisibility: canvasStyle?.visibility || "missing",
        canvasOpacity: canvasStyle?.opacity || "missing",
      };
      originalDispose();
    };
  });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
  });

  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __disposeVisualState?: unknown }).__disposeVisualState,
  )).not.toBeUndefined();
  const disposeVisualState = await page.evaluate(() => (window as unknown as { __disposeVisualState?: unknown }).__disposeVisualState);
  expect(disposeVisualState).toEqual(expect.objectContaining({
    loadState: "prefill-loading",
    canvasVisibility: "hidden",
    canvasOpacity: "0",
  }));
});

test("desktop keyboard session switch paints loading before terminal teardown", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { state: { allSessions: readonly unknown[] } }).state.allSessions.length,
  )).toBeGreaterThan(1);

  await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const controller = (window as unknown as { state: { terminalController?: { dispose?: () => void } } }).state.terminalController;
    if (!container || !controller?.dispose) throw new Error("missing terminal controller");

    const originalAdd = DOMTokenList.prototype.add;
    (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen = false;
    DOMTokenList.prototype.add = function (...tokens: string[]) {
      const result = originalAdd.apply(this, tokens);
      if (this === container.classList && tokens.includes("hydrating")) {
        (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen = false;
        requestAnimationFrame(() => {
          (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen = true;
        });
      }
      return result;
    };

    const originalDispose = controller.dispose.bind(controller);
    controller.dispose = () => {
      const canvas = container.querySelector("canvas");
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      (window as unknown as { __keyboardDisposeVisualState?: unknown }).__keyboardDisposeVisualState = {
        loadingPaintSeen: (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen === true,
        loadState: container.getAttribute("data-terminal-load-state") || "",
        canvasVisibility: canvasStyle?.visibility || "missing",
        canvasOpacity: canvasStyle?.opacity || "missing",
      };
      originalDispose();
    };
  });

  await page.keyboard.down("Meta");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Meta");

  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __keyboardDisposeVisualState?: unknown }).__keyboardDisposeVisualState,
  )).not.toBeUndefined();
  const disposeVisualState = await page.evaluate(() => (window as unknown as { __keyboardDisposeVisualState?: unknown }).__keyboardDisposeVisualState);
  expect(disposeVisualState).toEqual(expect.objectContaining({
    loadingPaintSeen: true,
    loadState: "prefill-loading",
    canvasVisibility: "hidden",
    canvasOpacity: "0",
  }));
});

test("desktop full prefill records hydration timing after prefill_done", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  const timing = await page.evaluate(() => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; t: number }> }>;
    };
    const trace = Object.values(debugWindow.__wfTrace || {}).find((candidate) => candidate._meta.session === "test-project");
    if (!trace) throw new Error("missing trace");
    const at = (kind: string) => trace.events.find((event) => event.kind === kind)?.t;
    const prefillDone = at("prefill_done");
    const hydrationFinish = at("hydration.finish");
    if (prefillDone === undefined || hydrationFinish === undefined) throw new Error("missing hydration timing events");
    return {
      prefillDone,
      hydrationFinish,
      delta: +(hydrationFinish - prefillDone).toFixed(1),
    };
  });

  expect(timing.hydrationFinish).toBeGreaterThan(timing.prefillDone);
  expect(timing.delta).toBeLessThan(1000);
});

test("desktop full prefill writes chunks while hidden before prefill_done", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; bucket?: string }> }>;
    };
    const trace = Object.values(debugWindow.__wfTrace || {}).find((candidate) => candidate._meta.session === "test-project");
    if (!trace) return false;
    const prefillBinaryIndex = trace.events.findIndex((event) => event.kind === "ws.binary" && event.bucket === "prefill");
    const firstWriteIndex = trace.events.findIndex((event) => event.kind === "_writeTermData");
    const prefillDoneIndex = trace.events.findIndex((event) => event.kind === "prefill_done");
    const revealIndex = trace.events.findIndex((event) => event.kind === "hydration.reveal");
    return prefillBinaryIndex >= 0 && firstWriteIndex >= 0 && prefillDoneIndex >= 0 && revealIndex >= 0;
  }), { timeout: 5000 }).toBe(true);

  const order = await page.evaluate(() => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; bucket?: string }> }>;
    };
    const trace = Object.values(debugWindow.__wfTrace || {}).find((candidate) => candidate._meta.session === "test-project");
    if (!trace) throw new Error("missing trace");
    return {
      prefillBinaryIndex: trace.events.findIndex((event) => event.kind === "ws.binary" && event.bucket === "prefill"),
      firstWriteIndex: trace.events.findIndex((event) => event.kind === "_writeTermData"),
      prefillDoneIndex: trace.events.findIndex((event) => event.kind === "prefill_done"),
      revealIndex: trace.events.findIndex((event) => event.kind === "hydration.reveal"),
    };
  });

  expect(order.prefillBinaryIndex).toBeGreaterThanOrEqual(0);
  expect(order.firstWriteIndex).toBeGreaterThan(order.prefillBinaryIndex);
  expect(order.firstWriteIndex).toBeLessThan(order.prefillDoneIndex);
  expect(order.revealIndex).toBeGreaterThan(order.prefillDoneIndex);
});

test("desktop legacy saved fast prefill key is ignored", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "fast" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expectSoloAttachPrefillMode(page, "full");
});


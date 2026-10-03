import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EXTENSION_BUNDLE_MAX_BYTES,
  ExtensionBundleLoadError,
  loadAuthenticatedExtensionBundle,
} from "../../public/extension-loader.ts";

const asset = "/api/extensions/agent-context/bundle.js";
const wrongDigest = "0".repeat(64);
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

beforeEach(() => {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://127.0.0.1:12345/"),
  });
});
afterEach(() => {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

type Options = Parameters<typeof loadAuthenticatedExtensionBundle>[2];
async function failure(options: Options, url = asset, digest = wrongDigest): Promise<ExtensionBundleLoadError> {
  try {
    await loadAuthenticatedExtensionBundle(url, digest, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionBundleLoadError);
    return error as ExtensionBundleLoadError;
  }
  throw new Error("expected loader rejection before import");
}

function observedBody(headers: Record<string, string> = {}, status = 200) {
  let cancellations = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancellations++; },
  });
  return {
    response: new Response(body, { status, headers: { "content-type": "text/javascript", ...headers } }),
    cancellations: () => cancellations,
    abort: () => controller.error(new Error("guard cleanup")),
  };
}

// A test guard only: the loader must settle by its own deadline even if an
// injected transport ignores AbortSignal. On an old implementation, clean up
// the losing stream so this negative test never leaves a dangling operation.
async function guarded<T>(pending: Promise<T>, cleanup: () => void | Promise<void>): Promise<T | "guard-expired"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<"guard-expired">((resolve) => { timer = setTimeout(() => resolve("guard-expired"), 250); }),
    ]);
  } finally {
    clearTimeout(timer);
    await cleanup();
    await pending.catch(() => {});
  }
}

describe("extension loader authority and response cleanup", () => {
  test("safe mode precedes all validation and network activity", async () => {
    let calls = 0;
    const error = await failure({ safeMode: true, fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); } }, "http://[", "invalid");
    expect(error.code).toBe("SAFE_MODE");
    expect(calls).toBe(0);
  });

  test.each([
    "https://example.com/api/extensions/bundle.js",
    "/app.js",
    "/api/extensions/bundle.js?token=secret",
    "/api/extensions/bundle.js#fragment",
    "http://[",
    "http://user:secret@127.0.0.1:12345/api/extensions/bundle.js",
  ])("rejects invalid asset authority without fetch: %s", async (url) => {
    let calls = 0;
    const error = await failure({ safeMode: false, fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); } }, url);
    expect(error.code).toBe("INVALID_URL");
    expect(calls).toBe(0);
    expect(error.message).not.toContain("secret");
  });

  test("invalid digest is rejected before fetch", async () => {
    let calls = 0;
    expect((await failure({ safeMode: false, fetchImpl: async () => { calls++; throw new Error(); } }, asset, "bad")).code).toBe("INTEGRITY_MISMATCH");
    expect(calls).toBe(0);
  });

  test.each([401, 403, 500])("cancels body of unsuccessful HTTP %i", async (status) => {
    const observed = observedBody({}, status);
    expect((await failure({ safeMode: false, fetchImpl: async () => observed.response })).code).toBe("FETCH_FAILED");
    expect(observed.cancellations()).toBe(1);
  });

  test("enforces no-store and redirect:error request policy", async () => {
    const error = await failure({ safeMode: false, fetchImpl: async (url, init) => {
      expect(String(url)).toBe(`http://127.0.0.1:12345${asset}`);
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new Error("transport includes a secret");
    } });
    expect(error.code).toBe("FETCH_FAILED");
    expect(error.message).not.toContain("secret");
  });

  test("rejects and cancels a redirected response", async () => {
    const observed = observedBody();
    Object.defineProperty(observed.response, "redirected", { value: true });
    expect((await failure({ safeMode: false, fetchImpl: async () => observed.response })).code).toBe("RESPONSE_INVALID");
    expect(observed.cancellations()).toBe(1);
  });

  test.each(["text/html", "application/json", ""])('rejects and cancels MIME "%s"', async (mime) => {
    const observed = observedBody({ "content-type": mime });
    expect((await failure({ safeMode: false, fetchImpl: async () => observed.response })).code).toBe("RESPONSE_INVALID");
    expect(observed.cancellations()).toBe(1);
  });

  test("rejects absent response body", async () => {
    expect((await failure({ safeMode: false, fetchImpl: async () => new Response(null, { headers: { "content-type": "text/javascript" } }) })).code).toBe("RESPONSE_INVALID");
  });
});

describe("extension loader hard resource limits", () => {
  test.each([0, -1, Infinity, NaN, 1.5])("invalid byte limit %s is rejected before fetch", async (maxBytes) => {
    let calls = 0;
    const error = await failure({ safeMode: false, maxBytes, fetchImpl: async () => { calls++; return new Response("", { headers: { "content-type": "text/javascript" } }); } });
    expect(error.code).toBe("RESPONSE_TOO_LARGE");
    expect(calls).toBe(0);
  });

  test.each([0, -1, Infinity, NaN, 1.5])("invalid deadline %s is rejected before fetch", async (timeoutMs) => {
    let calls = 0;
    const error = await failure({ safeMode: false, timeoutMs, fetchImpl: async () => { calls++; return new Response("", { headers: { "content-type": "text/javascript" } }); } });
    expect(error.code).toBe("FETCH_FAILED");
    expect(calls).toBe(0);
  });

  test.each(["-1", "NaN", "1.5", "1e3", String(EXTENSION_BUNDLE_MAX_BYTES + 1)])("rejects declared length %s before reading and cancels body", async (length) => {
    const observed = observedBody({ "content-length": length });
    const pending = failure({ safeMode: false, timeoutMs: 20, fetchImpl: async () => observed.response });
    const result = await guarded(pending, observed.abort);
    expect(result).not.toBe("guard-expired");
    expect((result as ExtensionBundleLoadError).code).toBe("RESPONSE_TOO_LARGE");
    expect(observed.cancellations()).toBe(1);
  });

  test("enlarged caller limit cannot enlarge the host cap, even with lying Content-Length", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(EXTENSION_BUNDLE_MAX_BYTES + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/javascript", "content-length": "1" } });
    expect((await failure({ safeMode: false, maxBytes: 2 * EXTENSION_BUNDLE_MAX_BYTES, fetchImpl: async () => response })).code).toBe("RESPONSE_TOO_LARGE");
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test("allows a reduced cap and counts multiple chunks without Content-Length", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2)); controller.enqueue(new Uint8Array(2)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/javascript" } });
    expect((await failure({ safeMode: false, maxBytes: 3, fetchImpl: async () => response })).code).toBe("RESPONSE_TOO_LARGE");
    expect(cancelled).toBe(true);
  });

  test("deadline covers headers even when transport ignores abort; late response is cancelled", async () => {
    let deliver!: (response: Response) => void;
    const observed = observedBody();
    let signal: AbortSignal | null | undefined;
    const pending = failure({ safeMode: false, timeoutMs: 20, fetchImpl: async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => { deliver = resolve; });
    } });
    const result = await guarded(pending, async () => {
      deliver(observed.response);
      await new Promise((resolve) => setTimeout(resolve, 0));
      observed.abort();
    });
    expect(result).not.toBe("guard-expired");
    expect((result as ExtensionBundleLoadError).code).toBe("FETCH_FAILED");
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(observed.cancellations()).toBe(1);
  });

  test("deadline covers a stalled body even when the stream ignores abort", async () => {
    const observed = observedBody();
    const pending = failure({ safeMode: false, timeoutMs: 20, fetchImpl: async () => observed.response });
    const result = await guarded(pending, observed.abort);
    expect(result).not.toBe("guard-expired");
    expect((result as ExtensionBundleLoadError).code).toBe("FETCH_FAILED");
    expect(observed.cancellations()).toBe(1);
    expect(observed.response.body?.locked).toBe(false);
  });

  test("body transport failures are typed and release the reader", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("private transport error")); } }), { headers: { "content-type": "text/javascript" } });
    const error = await failure({ safeMode: false, fetchImpl: async () => response });
    expect(error.code).toBe("FETCH_FAILED");
    expect(error.message).not.toContain("private");
    expect(response.body?.locked).toBe(false);
  });

  test("valid size and MIME reach digest verification, not import", async () => {
    const response = new Response("export const value = 1;", { headers: { "content-type": "text/javascript; charset=utf-8" } });
    expect((await failure({ safeMode: false, fetchImpl: async () => response })).code).toBe("INTEGRITY_MISMATCH");
    expect(response.body?.locked).toBe(false);
  });
});

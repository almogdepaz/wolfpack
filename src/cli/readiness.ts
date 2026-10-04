import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { sleepSync } from "./config.js";

export const APPLICATION_READY_TIMEOUT_MS = 10000;
const READY_POLL_INTERVAL_MS = 100;
const HEALTH_PROBE_TIMEOUT_MS = 500;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const HEALTH_PATH = "/api/health";
const CURL_PREREQUISITE_ERROR = "Managed service activation requires runnable curl on PATH. Install curl or fix PATH, then retry. Foreground startup does not require curl.";

/** Check probe tooling before any disruptive managed activation work. */
export function requireManagedCurl(): void {
  const probe = spawnSync("curl", ["--version"], {
    timeout: HEALTH_PROBE_TIMEOUT_MS, maxBuffer: MAX_HEALTH_RESPONSE_BYTES,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (probe.error || probe.status !== 0) throw new Error(CURL_PREREQUISITE_ERROR, { cause: probe.error });
}

export function isApplicationReady(health: unknown): boolean {
  return typeof health === "object" && health !== null
    && "status" in health && health.status === "ready"
    && "broker" in health && typeof health.broker === "object" && health.broker !== null
    && "state" in health.broker && health.broker.state === "ready";
}

/** Direct loopback HTTP deliberately ignores inherited proxy configuration. */
export function applicationReady(port: number, timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const req = request({ hostname: "127.0.0.1", port, path: HEALTH_PATH, agent: false }, response => {
      response.once("error", () => finish(false));
      response.once("aborted", () => finish(false));
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) { finish(false); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_HEALTH_RESPONSE_BYTES) { finish(false); return; }
        chunks.push(chunk);
      });
      response.once("end", () => {
        let health: unknown;
        try { health = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { finish(false); return; } // malformed health is not readiness
        finish(isApplicationReady(health));
      });
    });
    // Bound the entire response, including a peer that trickles its body.
    const timeout = setTimeout(() => finish(false), timeoutMs);
    function finish(ready: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      req.destroy();
      resolve(ready);
    }
    req.once("error", () => finish(false));
    req.end();
  });
}

/** Synchronous managed commands establish endpoint health, not process identity. */
export function waitForApplicationReady(port: number, timeoutMs = APPLICATION_READY_TIMEOUT_MS): boolean {
  requireManagedCurl();
  const deadline = Date.now() + timeoutMs;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    // curl's -f accepts 3xx. Its machine-readable write-out goes to a
    // separate channel; -s suppresses human diagnostics on that channel.
    const probe = spawnSync("curl", ["-s", "--noproxy", "*", "--max-time", String(Math.min(HEALTH_PROBE_TIMEOUT_MS, remaining) / 1000), "--write-out", "%{stderr}%{http_code}", `http://127.0.0.1:${port}${HEALTH_PATH}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: remaining, maxBuffer: MAX_HEALTH_RESPONSE_BYTES,
    });
    // Deadline/response limits are unhealthy-app evidence, not missing tooling.
    const errorCode = probe.error && "code" in probe.error ? probe.error.code : undefined;
    if (probe.error && errorCode !== "ETIMEDOUT" && errorCode !== "ENOBUFS") {
      throw new Error(CURL_PREREQUISITE_ERROR, { cause: probe.error });
    }
    const status = Number(probe.stderr);
    try {
      if (!probe.error && probe.status === 0 && status >= 200 && status < 300
        && isApplicationReady(JSON.parse(probe.stdout))) return true;
    } catch { /* malformed health cannot prove readiness */ }
    sleepSync(Math.max(0, Math.min(READY_POLL_INTERVAL_MS, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

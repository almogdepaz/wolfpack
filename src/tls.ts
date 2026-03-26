/**
 * Self-signed TLS certificate generation for localhost HTTPS.
 * Uses openssl (pre-installed on macOS/Linux) — no npm dependencies.
 */
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./log.js";

const log = createLogger("tls");

export const TLS_DIR = join(homedir(), ".wolfpack", "tls");
const CERT_PATH = join(TLS_DIR, "cert.pem");
const KEY_PATH = join(TLS_DIR, "key.pem");

export interface TlsCreds {
  cert: Buffer;
  key: Buffer;
}

/**
 * Ensure a self-signed cert exists at ~/.wolfpack/tls/.
 * Generates one via openssl if missing. Returns null on failure (no openssl, etc).
 */
export function ensureSelfSignedCert(dir = TLS_DIR): TlsCreds | null {
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");

  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    } catch (e: unknown) {
      log.warn("failed to read existing certs, regenerating", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync("openssl", [
      "req", "-x509",
      "-newkey", "ec",
      "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "3650",
      "-nodes",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o644);

    log.info("generated self-signed cert", { path: dir });
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch (e: unknown) {
    log.warn("failed to generate self-signed cert — HTTPS disabled", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

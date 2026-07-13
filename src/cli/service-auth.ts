import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getJwtAuthConfig, verifyJwtAuthAtStartup } from "../auth.js";

const SERVICE_AUTH_KEYS = [
  "WOLFPACK_JWT_SECRET",
  "WOLFPACK_JWT_ISSUER",
  "WOLFPACK_JWT_AUDIENCE",
  "WOLFPACK_JWT_CLOCK_TOLERANCE_SEC",
] as const;

type ServiceAuthKey = typeof SERVICE_AUTH_KEYS[number];
type ServiceAuthEnvironment = Partial<Record<ServiceAuthKey, string>>;

function validateCredentialFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`service auth credential is not a regular file: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`service auth credential has unsafe permissions: ${path}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`service auth credential is not owned by the current user: ${path}`);
  }
}

function parseServiceAuthFile(path: string): ServiceAuthEnvironment {
  validateCredentialFile(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error: unknown) {
    throw new Error(`invalid service auth credential: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid service auth credential: expected an object");
  }

  const source = value as Record<string, unknown>;
  const credential: ServiceAuthEnvironment = {};
  for (const key of SERVICE_AUTH_KEYS) {
    const field = source[key];
    if (field === undefined) continue;
    if (typeof field !== "string") {
      throw new Error(`invalid service auth credential field: ${key}`);
    }
    credential[key] = field;
  }
  if (Object.keys(source).some(key => !SERVICE_AUTH_KEYS.includes(key as ServiceAuthKey))) {
    throw new Error("invalid service auth credential: unsupported field");
  }

  const auth = getJwtAuthConfig(credential);
  if (verifyJwtAuthAtStartup(auth) !== "ok") {
    throw new Error(auth.invalidReason ?? "service auth credential has no JWT secret");
  }
  return credential;
}

function credentialFromEnvironment(env: NodeJS.ProcessEnv): ServiceAuthEnvironment | null {
  const auth = getJwtAuthConfig(env);
  const status = verifyJwtAuthAtStartup(auth);
  if (status === "invalid") {
    throw new Error(auth.invalidReason ?? "invalid WOLFPACK_JWT_SECRET");
  }
  if (status === "missing") return null;

  return {
    WOLFPACK_JWT_SECRET: auth.secret,
    ...(auth.issuer && { WOLFPACK_JWT_ISSUER: auth.issuer }),
    ...(auth.audience && { WOLFPACK_JWT_AUDIENCE: auth.audience }),
    WOLFPACK_JWT_CLOCK_TOLERANCE_SEC: String(auth.clockToleranceSec),
  };
}

export function prepareServiceAuthFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): "written" | "preserved" | "absent" {
  const credential = credentialFromEnvironment(env);
  if (!credential) {
    if (!existsSync(path)) return "absent";
    parseServiceAuthFile(path);
    return "preserved";
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(credential, null, 2), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return "written";
}

export function applyServiceAuthFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!existsSync(path)) {
    throw new Error(`configured service auth credential not found: ${path}`);
  }
  const credential = parseServiceAuthFile(path);
  for (const key of SERVICE_AUTH_KEYS) delete env[key];
  Object.assign(env, credential);
  return true;
}

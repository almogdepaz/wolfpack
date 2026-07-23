import { basename } from "node:path";

const HUNK_COMMAND = "hunk";
const WOLFPACK_COMMAND = "wolfpack";
const HUNK_DIFF_COMMAND = "exec hunk diff --watch";
const HUNK_SESSION_HARNESS = "shell";
const HUNK_PREFLIGHT_TIMEOUT_MS = 5_000;
const WOLFPACK_CREATE_TIMEOUT_MS = 15_000;
const WOLFPACK_SEND_TIMEOUT_MS = 5_000;
const MAX_STRUCTURED_ERROR_CHARS = 160;
const POST_CREATE_PARTIAL_ERROR_CODES = new Set([
  "PARENT_SESSION_CHANGED",
  "PARENT_SESSION_NOT_FOUND",
]);

type NotificationLevel = "info" | "warning" | "error";

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed?: boolean;
}

interface ExecOptions {
  readonly timeout: number;
}

interface PiApi {
  readonly registerCommand: (name: string, command: {
    readonly description: string;
    readonly handler: (args: string, ctx: HunkCommandContext) => Promise<void>;
  }) => void;
  readonly exec: (command: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;
}

interface HunkCommandContext {
  readonly ui: {
    readonly notify: (message: string, level: NotificationLevel) => void;
  };
}

interface CommandFailure {
  readonly message: string;
}

interface CreateSuccess {
  readonly ok: true;
  readonly session: string;
  readonly sessionId: string;
  readonly project: string;
  readonly harness: string;
}

interface CreatedSessionIdentity {
  readonly session: string;
  readonly sessionId: string;
  readonly project: string;
  readonly harness: string;
}

interface SendSuccess {
  readonly ok: true;
  readonly session: string;
  readonly sessionId: string;
}

function notify(ctx: HunkCommandContext, message: string, level: NotificationLevel): void {
  ctx.ui.notify(message, level);
}

function wolfpackContextFromEnv(env: Readonly<Record<string, string | undefined>>):
  | { readonly ok: true; readonly project: string }
  | { readonly ok: false } {
  const projectDir = env.WOLFPACK_PROJECT_DIR?.trim();
  const sessionName = env.WOLFPACK_SESSION_NAME?.trim();
  if (!projectDir || !sessionName) return { ok: false };
  const project = basename(projectDir);
  if (!project || project === "." || project === "..") return { ok: false };
  return { ok: true, project };
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clampStructuredMessage(message: string): string {
  const trimmed = message.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= MAX_STRUCTURED_ERROR_CHARS) return trimmed;
  return `${chars.slice(0, MAX_STRUCTURED_ERROR_CHARS).join("")}…`;
}

function commandFailure(result: ExecResult, fallback: string): CommandFailure {
  const parsed = parseJsonObject(result.stdout);
  const error = parsed?.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return { message: clampStructuredMessage(message) };
  }
  return { message: fallback };
}

function parseCreatedSessionIdentity(value: unknown): CreatedSessionIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const created = value as Record<string, unknown>;
  if (
    typeof created.session !== "string"
    || typeof created.sessionId !== "string"
    || typeof created.project !== "string"
    || typeof created.harness !== "string"
  ) return null;
  return {
    session: created.session,
    sessionId: created.sessionId,
    project: created.project,
    harness: created.harness,
  };
}

function parseCreateSuccess(stdout: string): CreateSuccess | null {
  const parsed = parseJsonObject(stdout);
  const created = parseCreatedSessionIdentity(parsed);
  if (parsed?.ok === true && created) {
    return {
      ok: true,
      ...created,
    };
  }
  return null;
}

function parseStructuredFailureCode(parsed: Record<string, unknown> | null): string | null {
  const error = parsed?.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const code = parsed?.code;
  return typeof code === "string" ? code : null;
}

function parsePostCreateFailureSession(stdout: string, expectedProject: string): CreatedSessionIdentity | null {
  const parsed = parseJsonObject(stdout);
  const code = parseStructuredFailureCode(parsed);
  if (!code || !POST_CREATE_PARTIAL_ERROR_CODES.has(code)) return null;
  const created = parseCreatedSessionIdentity(parsed?.createdSession);
  if (!created || !isExpectedCreateSession(created, expectedProject)) return null;
  return created;
}

function parseSendSuccess(stdout: string): SendSuccess | null {
  const parsed = parseJsonObject(stdout);
  if (parsed?.ok === true && typeof parsed.session === "string" && typeof parsed.sessionId === "string") {
    return {
      ok: true,
      session: parsed.session,
      sessionId: parsed.sessionId,
    };
  }
  return null;
}

function isExpectedCreateSession(created: CreatedSessionIdentity, expectedProject: string): boolean {
  return created.session.trim().length > 0
    && created.sessionId.trim().length > 0
    && created.harness === HUNK_SESSION_HARNESS
    && created.project === expectedProject;
}

function isExpectedCreateSuccess(created: CreateSuccess, expectedProject: string): boolean {
  return isExpectedCreateSession(created, expectedProject);
}

async function safeExec(pi: PiApi, command: string, args: readonly string[], timeout: number): Promise<ExecResult> {
  try {
    return await pi.exec(command, args, { timeout });
  } catch (error: unknown) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkCommand(pi: PiApi, command: string): Promise<ExecResult> {
  return safeExec(pi, command, ["--version"], HUNK_PREFLIGHT_TIMEOUT_MS);
}

export async function runHunkCommand(pi: PiApi, args: string, ctx: HunkCommandContext): Promise<void> {
  if (args.trim()) {
    notify(ctx, "Usage: /hunk", "warning");
    return;
  }

  const wolfpackContext = wolfpackContextFromEnv(process.env);
  if (!wolfpackContext.ok) {
    notify(
      ctx,
      "Run /hunk from Pi inside a Wolfpack session with WOLFPACK_PROJECT_DIR and WOLFPACK_SESSION_NAME set.",
      "error",
    );
    return;
  }

  const hunkPreflight = await checkCommand(pi, HUNK_COMMAND);
  if (hunkPreflight.killed) {
    notify(ctx, "Timed out while checking whether Hunk is available.", "error");
    return;
  }
  if (hunkPreflight.code !== 0) {
    notify(ctx, "hunk is not available on PATH. Install Hunk on this host, then retry /hunk.", "error");
    return;
  }

  const createResult = await safeExec(pi, WOLFPACK_COMMAND, [
    "session",
    "create",
    wolfpackContext.project,
    "--harness",
    "shell",
    "--grid",
    "--json",
  ], WOLFPACK_CREATE_TIMEOUT_MS);
  if (createResult.killed) {
    notify(ctx, "Timed out while creating the Wolfpack Hunk session.", "error");
    return;
  }
  if (createResult.code === 127) {
    notify(ctx, "wolfpack CLI is not available on PATH. Install or expose wolfpack, then retry /hunk.", "error");
    return;
  }
  if (createResult.code !== 0) {
    const failure = commandFailure(createResult, "session creation failed");
    const createdSession = parsePostCreateFailureSession(createResult.stdout, wolfpackContext.project);
    if (createdSession) {
      notify(
        ctx,
        `Could not attach Hunk to the Wolfpack grid: ${failure.message}. Created Wolfpack session ${createdSession.session} (${createdSession.sessionId}) may still be running.`,
        "error",
      );
      return;
    }
    notify(
      ctx,
      `Could not create Wolfpack Hunk session: ${failure.message}`,
      "error",
    );
    return;
  }

  const created = parseCreateSuccess(createResult.stdout);
  if (!created) {
    notify(ctx, "Wolfpack returned malformed JSON while creating the Hunk session.", "error");
    return;
  }
  if (!isExpectedCreateSuccess(created, wolfpackContext.project)) {
    notify(ctx, "Wolfpack returned an incompatible Hunk session response.", "error");
    return;
  }

  const sendResult = await safeExec(pi, WOLFPACK_COMMAND, [
    "session",
    "send",
    created.sessionId,
    HUNK_DIFF_COMMAND,
    "--json",
  ], WOLFPACK_SEND_TIMEOUT_MS);
  if (sendResult.killed) {
    notify(
      ctx,
      `Created Wolfpack session ${created.session} (${created.sessionId}), but timed out while starting Hunk.`,
      "error",
    );
    return;
  }
  if (sendResult.code !== 0 || !parseSendSuccess(sendResult.stdout)) {
    notify(
      ctx,
      `Created Wolfpack session ${created.session} (${created.sessionId}), but could not start Hunk: ${commandFailure(sendResult, "send failed").message}`,
      "error",
    );
    return;
  }

  notify(ctx, `Hunk diff watcher opened in Wolfpack session ${created.session} (${created.sessionId}).`, "info");
}

export default function hunkExtension(pi: PiApi): void {
  pi.registerCommand("hunk", {
    description: "Open hunk diff --watch in a Wolfpack grid shell",
    handler: async (args, ctx) => {
      await runHunkCommand(pi, args, ctx);
    },
  });
}

import type { SessionInspectionResult } from "../session-status-contract.js";
import type {
  AgentKind,
  CaptureSessionIdentityInput,
  ParentSessionIdentity,
  PublicSessionIdentity,
} from "./session-identity.js";
import type {
  SessionPromptWaitOptions,
  SessionPromptWaitResult,
} from "../session-prompt-contract.js";

export class DuplicateSessionError extends Error {
  readonly code = "DUPLICATE_SESSION" as const;
  constructor(name: string) {
    super(`duplicate session: ${name}`);
    this.name = "DuplicateSessionError";
  }
}

export class UnsupportedTerminalKeyError extends Error {
  readonly code = "UNSUPPORTED_TERMINAL_KEY" as const;
  readonly key: string;

  constructor(key: string) {
    super(`unsupported terminal key: ${key}`);
    this.name = "UnsupportedTerminalKeyError";
    this.key = key;
  }
}

export interface SessionLaunchOptions {
  readonly agentKind?: AgentKind | string;
  readonly externalAgent?: CaptureSessionIdentityInput["externalAgent"];
  readonly parentSession?: ParentSessionIdentity;
  readonly model?: string;
  readonly initialPrompt?: string;
}

export interface SessionListFact {
  readonly name: string;
  readonly alive: boolean;
  /** Decimal broker PTY output watermark; absent when connected to an older broker. */
  readonly outputSequence?: string;
  readonly identity?: PublicSessionIdentity;
}

export interface CapturePaneOptions {
  /** Maximum broker scrollback rows to include; zero captures only the visible screen. */
  readonly scrollbackLines?: number;
}

export interface SessionBackend {
  /** Live-only session names for terminal attach/control consumers. */
  list(): Promise<string[]>;
  /** Authoritative complete session table for canonical runtime projection. */
  listSessionFacts(): Promise<SessionListFact[]>;
  listIdentities?(): Promise<Record<string, PublicSessionIdentity>>;
  inspectSession?(selector: string): Promise<SessionInspectionResult>;
  createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
    options?: SessionLaunchOptions,
  ): Promise<PublicSessionIdentity>;
  killSession(name: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  capturePane(name: string, options?: CapturePaneOptions): Promise<string>;
  resize(name: string, cols: number, rows: number): Promise<void>;
  send(name: string, text: string, noEnter?: boolean): Promise<void>;
  sendKey(name: string, key: string): Promise<void>;
  sessionDir(name: string): string | undefined;
  cleanupOrphans(): Promise<void>;
}

// ── Broker streaming/attach methods needed by websocket.ts ──

/**
 * Lifecycle event delivered to `onSessionLifecycle` subscribers.
 *  - `exited`: the broker fires this when a session's child reaps.
 *  - `replay_truncated`: the broker reported `replay_truncated: true` on a
 *    `subscribe` response (ring overrun during the lag window).
 *    Subscribers should force a re-snapshot — in practice the WS layer
 *    closes the viewer with 1011 so the client reconnects and re-prefills
 *    instead of sitting on out-of-sync output.
 */
export type SessionLifecycleEvent =
  | { kind: "exited"; exitCode?: number; signal?: number }
  | { kind: "replay_truncated" };

export interface SessionPrefill {
  data: Buffer;
  /** Final broker PTY-chunk seq covered by the snapshot; undefined for non-broker backends. */
  seq?: bigint;
}

export interface SessionPrefillOptions {
  /** Limit broker scrollback rows before rendering; omit for backend default. */
  readonly scrollbackLines?: number;
}

export type SessionDataUnsubscribe = (() => void) & {
  /** Resolves once the broker accepts (or rejects) the shared subscription. */
  ready?: Promise<boolean>;
  /** Resolves after this subscriber's final detach reaches the broker. */
  closed?: Promise<void>;
};

export interface SessionAttachLease {
  readonly prefill: SessionPrefill;
  /** Consume the lease by transferring its live stream to this subscriber. */
  activate(
    cb: (data: Uint8Array) => void,
    opts: { readonly onSubscribeError: (err: unknown) => void },
  ): SessionDataUnsubscribe | null;
  /** Release an unactivated lease. Idempotent; a consumed lease is unchanged. */
  cancel(): Promise<void>;
}

export interface PtyBackendMethods {
  onSessionData(
    name: string,
    cb: (data: Uint8Array) => void,
    opts: {
      sinceSeq?: bigint;
      /**
       * Async-failure escape hatch. The broker `subscribe` RPC is fire-and-
       * forget from the caller's perspective — a synchronous unsub function
       * is returned immediately. If the RPC later rejects, the backend has
       * unwound its local refcount but the WS layer's reference to the
       * (now dead) callback is still in `entry.unsubscribe`, leaving the
       * viewer connected with no data stream forever. The callback is
       * REQUIRED so callers can't silently regress the dead-viewer fix;
       * pass `() => {}` for fire-and-forget probe paths that don't care
       * about teardown.
       */
      onSubscribeError: (err: unknown) => void;
    },
  ): SessionDataUnsubscribe | null;
  writeToTerminal(name: string, data: Buffer | string): boolean;
  /**
   * Returns prefill bytes + snapshot seq for the WS attach handler.
   * Async because the broker sources prefill from a snapshot RPC.
   */
  getSessionPrefill(name: string, cols?: number, options?: SessionPrefillOptions): SessionPrefill | Promise<SessionPrefill>;
  /** Own an atomic snapshot/live cut until the caller activates or cancels it. */
  beginSessionAttach(name: string, cols?: number, options?: SessionPrefillOptions): Promise<SessionAttachLease>;
  isSessionAlive(name: string): boolean;
  /**
   * Register a lifecycle callback for a session (currently: exit only).
   * Returns null when the backend cannot resolve the name (e.g. broker
   * cache cold or session unknown).
   */
  onSessionLifecycle(
    name: string,
    cb: (event: SessionLifecycleEvent) => void,
  ): (() => void) | null;
}

export interface SessionPromptBackendMethods {
  /**
   * Register output observation for a pinned broker UUID before writing input,
   * then wait only for explicit output containment.
   */
  promptAndWaitForOutput(
    sessionId: string,
    options: SessionPromptWaitOptions,
  ): Promise<SessionPromptWaitResult>;
}

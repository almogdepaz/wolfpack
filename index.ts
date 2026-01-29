import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadState,
  enableBridge,
  disableBridge,
  pauseBridge,
  resumeBridge,
  getBridge,
  getAllBridges,
  extractGroupJid,
  isValidGroupJid,
} from "./src/bridge-state.js";
import {
  tmuxSessionExists,
  tmuxSendText,
} from "./src/tmux-io.js";
import * as outputWatcher from "./src/output-watcher.js";
import { DEFAULT_OUTPUT_PREFIX, GROUP_NAME_PREFIX } from "./src/constants.js";

let stateDir: string;

// =============================================================================
// sessions.json reader — get group name from Clawdbot session metadata
// =============================================================================
interface SessionMeta {
  subject?: string;
  groupId?: string;
  chatType?: string;
}

function readSessionMeta(agentId: string, sessionKey: string): SessionMeta | null {
  try {
    // ctx.agentId may be "agent" while actual agent dir is "main"
    // Extract from sessionKey (format: "agent:<name>:...")
    const skMatch = sessionKey.match(/^agent:([^:]+):/);
    const resolvedAgentId = skMatch ? skMatch[1] : agentId;
    const p = join(
      process.env.HOME ?? "~",
      ".clawdbot",
      "agents",
      resolvedAgentId,
      "sessions",
      "sessions.json"
    );
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf-8"));
    return data[sessionKey] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract tmux session name from a group name with the cc- prefix.
 * "cc-playground" -> "playground", "random-group" -> null
 */
function extractTmuxName(groupName: string): string | null {
  const lower = groupName.toLowerCase();
  if (!lower.startsWith(GROUP_NAME_PREFIX)) return null;
  const name = groupName.slice(GROUP_NAME_PREFIX.length).trim();
  if (!name) return null;
  // Sanitize: only allow alphanumeric, dash, underscore, dot
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  return name;
}

/**
 * Strip Clawdbot's message wrapper to get the raw user text.
 * Input format: "[WhatsApp <jid> <time>] <sender>: <body>\n[message_id: ...]"
 * Returns just "<body>".
 */
function extractMessageBody(prompt: string): string {
  // Match: [WhatsApp ...] Sender: <body>
  const headerMatch = prompt.match(/^\[WhatsApp [^\]]+\]\s*[^:]+:\s*/);
  if (!headerMatch) return prompt; // Not a WhatsApp wrapper, return as-is

  let body = prompt.slice(headerMatch[0].length);

  // Strip trailing [message_id: ...] line
  body = body.replace(/\n\[message_id:\s*[^\]]*\]\s*$/, "");

  return body.trim();
}

export default function register(api: ClawdbotPluginApi) {
  const logger = api.logger;
  const pluginConfig = api.pluginConfig ?? {};

  logger.info("claude-bridge plugin loaded");

  // Helper to send a WhatsApp message to a group
  async function sendToGroup(groupJid: string, text: string): Promise<void> {
    if (!isValidGroupJid(groupJid)) return;
    await api.runtime.channel.whatsapp.sendMessageWhatsApp(
      groupJid,
      text,
      { accountId: "default" }
    );
  }

  // =========================================================================
  // Hook: before_agent_start — deterministic bridge routing (no LLM involvement)
  // =========================================================================
  api.on(
    "before_agent_start",
    async (
      event: { prompt: string; messages: unknown[] },
      ctx: { agentId: string; sessionKey: string; workspaceDir: string }
    ) => {
      const { sessionKey, agentId } = ctx;
      if (!sessionKey) return undefined;
      if (!stateDir) return undefined;

      // Only act on WhatsApp group sessions
      const groupJid = extractGroupJid(sessionKey);
      if (!groupJid) return undefined;

      const prefix = (pluginConfig as Record<string, unknown>).outputPrefix as string ?? DEFAULT_OUTPUT_PREFIX;
      const rawPrompt = event.prompt ?? "";

      // Strip Clawdbot message wrapper:
      // [WhatsApp <jid> <time>] <sender>: <body>\n[message_id: ...]
      const userMessage = extractMessageBody(rawPrompt);

      // --- Echo detection (all modes) ---
      if (userMessage.startsWith(prefix)) {
        return {
          prependContext: `[SYSTEM: Echo of bot output. Ignore completely. Do not respond.]`,
        };
      }
      if (outputWatcher.wasRecentlySent(userMessage)) {
        return {
          prependContext: `[SYSTEM: Echo of recently sent output. Ignore completely. Do not respond.]`,
        };
      }

      // --- Check existing bridge ---
      const bridge = getBridge(stateDir, sessionKey);

      if (bridge) {
        // === BRIDGE EXISTS ===

        // !pause command
        if (userMessage.trim().toLowerCase() === "!pause") {
          pauseBridge(stateDir, sessionKey);
          await outputWatcher.removeSession(sessionKey);
          return {
            prependContext: `[SYSTEM: Bridge to "${bridge.tmuxSession}" paused by user. Reply: "Bridge paused. Messages will no longer be forwarded. Send !resume to reconnect."]`,
          };
        }

        // !resume command
        if (userMessage.trim().toLowerCase() === "!resume") {
          if (bridge.paused) {
            resumeBridge(stateDir, sessionKey);
            await outputWatcher.addSession(sessionKey, bridge.tmuxSession, bridge.groupJid);
            return {
              prependContext: `[SYSTEM: Bridge to "${bridge.tmuxSession}" resumed. Reply: "Bridge resumed. Messages are being forwarded again."]`,
            };
          }
          return {
            prependContext: `[SYSTEM: Bridge to "${bridge.tmuxSession}" is already active. Reply: "Bridge is already active."]`,
          };
        }

        // ! escape prefix — talk to Clawdbot directly
        if (userMessage.startsWith("!")) {
          return {
            prependContext: [
              `[CLAWDBOT MODE — bridge to "${bridge.tmuxSession}" is active but user used ! escape]`,
              `Strip the leading "!" and respond normally.`,
              `User can say !pause to pause the bridge or !resume to resume it.`,
            ].join("\n"),
          };
        }

        // If paused, don't forward — let agent handle normally
        if (bridge.paused) {
          return {
            prependContext: `[SYSTEM: Bridge to "${bridge.tmuxSession}" is paused. Respond normally. User can say !resume to re-activate.]`,
          };
        }

        // --- Forward to tmux ---
        try {
          if (await tmuxSessionExists(bridge.tmuxSession)) {
            await tmuxSendText(bridge.tmuxSession, userMessage);
            return {
              prependContext: [
                `[BRIDGE MODE — message forwarded to tmux "${bridge.tmuxSession}"]`,
                `The message has already been sent. Reply with just "\u2192" and nothing else.`,
              ].join("\n"),
            };
          } else {
            // tmux session gone — auto-disable
            disableBridge(stateDir, sessionKey);
            await outputWatcher.removeSession(sessionKey);
            return {
              prependContext: `[BRIDGE ERROR] tmux session "${bridge.tmuxSession}" no longer exists. Bridge auto-disabled. Tell the user.`,
            };
          }
        } catch (err) {
          return {
            prependContext: `[BRIDGE ERROR] Failed to forward to tmux "${bridge.tmuxSession}": ${err}. Tell the user.`,
          };
        }
      }

      // === NO BRIDGE — check for auto-pairing ===
      const meta = readSessionMeta(agentId, sessionKey);
      if (!meta?.subject) return undefined;

      const tmuxName = extractTmuxName(meta.subject);
      if (!tmuxName) return undefined;

      // Check if tmux session exists
      if (!(await tmuxSessionExists(tmuxName))) return undefined;

      // Auto-bridge! Enable and start watching.
      const entry = enableBridge(stateDir, sessionKey, tmuxName, groupJid, meta.subject);
      if (!entry) return undefined;

      await outputWatcher.addSession(sessionKey, tmuxName, groupJid);

      // First-bridge confirmation message
      try {
        await sendToGroup(
          groupJid,
          `\u{1F517} Bridge activated: "${meta.subject}" \u2194 tmux "${tmuxName}"\nMessages here will be forwarded to Claude Code.\nPrefix with ! to talk to Clawdbot. Use !pause / !resume to control the bridge.`
        );
      } catch {
        // Non-fatal
      }

      logger.info(`Auto-bridged "${meta.subject}" -> tmux "${tmuxName}" (${groupJid})`);

      // Forward the current message that triggered the bridge
      try {
        await tmuxSendText(tmuxName, userMessage);
        return {
          prependContext: [
            `[BRIDGE MODE — auto-bridged and message forwarded to tmux "${tmuxName}"]`,
            `The message has already been sent. Reply with just "\u2192" and nothing else.`,
          ].join("\n"),
        };
      } catch (err) {
        return {
          prependContext: `[BRIDGE ERROR] Auto-bridged but failed to forward: ${err}. Tell the user.`,
        };
      }
    }
  );

  // =========================================================================
  // Background Service: output-watcher
  // =========================================================================
  api.registerService({
    id: "claude-bridge-output-watcher",

    async start(params) {
      stateDir = params.stateDir;
      const svcLogger = params.logger;

      const sendFn = async (groupJid: string, text: string) => {
        if (!isValidGroupJid(groupJid)) {
          svcLogger.error(`BLOCKED: refusing to send to non-group JID: ${groupJid}`);
          return;
        }
        try {
          await api.runtime.channel.whatsapp.sendMessageWhatsApp(
            groupJid,
            text,
            { accountId: "default" }
          );
        } catch (err) {
          svcLogger.error(`sendMessageWhatsApp failed: ${err}`);
        }
      };

      outputWatcher.init({
        sendMessageFn: sendFn,
        logInfoFn: (msg) => svcLogger.info(msg),
        logErrorFn: (msg) => svcLogger.error(msg),
        config: {
          outputPrefix: (pluginConfig as Record<string, unknown>).outputPrefix as string | undefined,
          quietTimeoutMs: (pluginConfig as Record<string, unknown>).quietTimeoutMs as number | undefined,
          maxOutputChars: (pluginConfig as Record<string, unknown>).maxOutputChars as number | undefined,
        },
      });

      // Restore watchers for previously enabled bridges (non-paused only)
      const bridges = getAllBridges(stateDir);
      for (const [sessionKey, entry] of bridges) {
        if (entry.paused) {
          svcLogger.info(`Skipping paused bridge: ${entry.tmuxSession} (${sessionKey})`);
          continue;
        }
        svcLogger.info(
          `Restoring bridge: ${entry.tmuxSession} -> ${entry.groupJid} (${sessionKey})`
        );
        await outputWatcher.addSession(
          sessionKey,
          entry.tmuxSession,
          entry.groupJid
        );
      }

      svcLogger.info(
        `claude-bridge output watcher started (${bridges.length} bridges, ${bridges.filter(([, e]) => !e.paused).length} active)`
      );
    },

    async stop(params) {
      await outputWatcher.stopAll();
      params.logger.info("claude-bridge output watcher stopped");
    },
  });

  logger.info("claude-bridge: registered hook and service (no tools — deterministic routing)");
}

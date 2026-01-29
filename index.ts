import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import {
  enableBridge,
  disableBridge,
  pauseBridge,
  resumeBridge,
  getBridge,
  getAllBridges,
  extractGroupJid,
  isValidGroupJid,
  consumeToken,
} from "./src/bridge-state.js";
import {
  tmuxSessionExists,
  tmuxSendText,
} from "./src/tmux-io.js";
import * as outputWatcher from "./src/output-watcher.js";
import { DEFAULT_OUTPUT_PREFIX, GROUP_NAME_PREFIX } from "./src/constants.js";

let stateDir: string;

/**
 * Extract tmux session name from a group name with the cc- prefix.
 * "cc-playground" -> "playground", "random-group" -> null
 */
function extractTmuxName(groupName: string): string | null {
  const lower = groupName.toLowerCase();
  if (!lower.startsWith(GROUP_NAME_PREFIX)) return null;
  const name = groupName.slice(GROUP_NAME_PREFIX.length).trim();
  if (!name) return null;
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

/**
 * Get group subject (name) via WhatsApp API.
 */
async function getGroupSubject(api: ClawdbotPluginApi, groupJid: string): Promise<string | null> {
  try {
    const listener = api.runtime.channel.whatsapp.getActiveWebListener("default");
    const meta = await listener.sock.groupMetadata(groupJid);
    return meta?.subject ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate that a WhatsApp group has exactly 1 participant (solo group).
 */
async function validateSoloGroup(api: ClawdbotPluginApi, groupJid: string): Promise<boolean> {
  try {
    const listener = api.runtime.channel.whatsapp.getActiveWebListener("default");
    const meta = await listener.sock.groupMetadata(groupJid);
    return meta.participants.length === 1;
  } catch {
    return false;
  }
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
      const { sessionKey } = ctx;
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

      // === NO BRIDGE — check for !activate <token> ===
      const activateMatch = userMessage.match(/^!activate\s+(\S+)$/i);
      if (!activateMatch) return undefined;

      const token = activateMatch[1];
      const tokenResult = consumeToken(token);

      if (!tokenResult) {
        return {
          prependContext: `[SYSTEM: Invalid or expired activation token. Reply: "Activation failed: invalid or expired token. Generate a new one via Telegram."]`,
        };
      }

      // Validate group name matches token's tmux session
      // We need the group subject — read from session metadata
      const groupSubject = await getGroupSubject(api, groupJid);
      if (!groupSubject) {
        return {
          prependContext: `[SYSTEM: Could not read group metadata. Reply: "Activation failed: unable to verify group name."]`,
        };
      }

      const tmuxName = extractTmuxName(groupSubject);
      if (!tmuxName || tmuxName !== tokenResult.tmuxSession) {
        return {
          prependContext: `[SYSTEM: Group name mismatch. Expected cc-${tokenResult.tmuxSession}, got "${groupSubject}". Reply: "Activation failed: group name doesn't match the bridge session."]`,
        };
      }

      // Validate solo group (only 1 participant)
      const isSolo = await validateSoloGroup(api, groupJid);
      if (!isSolo) {
        return {
          prependContext: `[SYSTEM: Group has more than 1 participant. Reply: "Activation failed: bridge groups must have only you as a member (solo group)."]`,
        };
      }

      // Check tmux session exists
      if (!(await tmuxSessionExists(tmuxName))) {
        return {
          prependContext: `[SYSTEM: tmux session "${tmuxName}" not found. Reply: "Activation failed: tmux session doesn't exist."]`,
        };
      }

      // All checks passed — activate bridge
      const entry = enableBridge(stateDir, sessionKey, tmuxName, groupJid, groupSubject);
      if (!entry) return undefined;

      await outputWatcher.addSession(sessionKey, tmuxName, groupJid);

      try {
        await sendToGroup(
          groupJid,
          `Bridge activated: "${groupSubject}" <-> tmux "${tmuxName}"\nMessages here will be forwarded to Claude Code.\nPrefix with ! to talk to Clawdbot. Use !pause / !resume to control the bridge.`
        );
      } catch {
        // Non-fatal
      }

      logger.info(`Token-activated bridge: "${groupSubject}" -> tmux "${tmuxName}" (${groupJid})`);

      return {
        prependContext: [
          `[BRIDGE MODE — activated via token, tmux "${tmuxName}"]`,
          `Bridge is now active. Reply: "Bridge activated successfully."`,
        ].join("\n"),
      };
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

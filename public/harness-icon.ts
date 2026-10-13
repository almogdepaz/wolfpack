import { CUSTOM_AGENT_KIND, isKnownAgentKind } from "../src/agent-kind";

/**
 * Small badge next to a session name showing which harness runs in it.
 * Renders nothing for custom or unrecognised kinds; the glyph itself comes
 * from CSS keyed on `data-harness`, so the markup carries no user text.
 */
export function harnessIconHtml(agentKind: unknown): string {
  if (typeof agentKind !== "string" || agentKind === CUSTOM_AGENT_KIND || !isKnownAgentKind(agentKind)) return "";
  return `<span class="harness-icon" data-harness="${agentKind}" role="img" aria-label="${agentKind}" title="${agentKind}"></span>`;
}

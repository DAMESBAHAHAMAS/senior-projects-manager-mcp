/**
 * Registry of deployed Zia agents this gateway can trigger.
 *
 * The gateway itself (OAuth, HTTP client, MCP transport) has no knowledge of
 * any specific agent — it only knows how to trigger "an agent by numeric Zia
 * agent id". Everything agent-specific lives here. Adding a new agent means
 * adding an entry to this registry, not touching the client or transport.
 */

export interface ZiaAgentDefinition {
  /** Stable key used to select this agent through the gateway. */
  key: string;
  /** Human-readable name, for error messages and tool descriptions. */
  displayName: string;
  /** Numeric Zia agent id from ziaagents.zoho.com, used to build the trigger URL. */
  agentId: string;
}

const SENIOR_PROJECTS_MANAGER: ZiaAgentDefinition = {
  key: "senior-projects-manager",
  displayName: "Senior Projects Manager",
  agentId: process.env.ZIA_SENIOR_PROJECTS_MANAGER_AGENT_ID ?? "20971000000021961",
};

export const ZIA_AGENTS: Record<string, ZiaAgentDefinition> = {
  [SENIOR_PROJECTS_MANAGER.key]: SENIOR_PROJECTS_MANAGER,
};

/** Agent used when a caller doesn't specify one. */
export const DEFAULT_ZIA_AGENT_KEY = process.env.ZIA_DEFAULT_AGENT ?? SENIOR_PROJECTS_MANAGER.key;

export function resolveZiaAgent(key?: string): ZiaAgentDefinition {
  const resolvedKey = key ?? DEFAULT_ZIA_AGENT_KEY;
  const agent = ZIA_AGENTS[resolvedKey];
  if (!agent) {
    throw new Error(
      `Unknown Zia agent "${resolvedKey}". Known agents: ${Object.keys(ZIA_AGENTS).join(", ")}`
    );
  }
  return agent;
}

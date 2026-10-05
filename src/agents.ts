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

/**
 * Function agents that exist in the registry only once their numeric Zia
 * agent id is supplied through the environment. Until an agent is seeded and
 * deployed in Zia Agent Studio, its env var stays unset, the agent is absent
 * from the registry, and any chat channel routed to it stays inactive. Turning
 * a function on is therefore one env var on the host — no code change.
 *
 * Display names follow the Function Registry naming rule: function name +
 * "Agent".
 */
const OPTIONAL_FUNCTION_AGENTS: ReadonlyArray<{ key: string; displayName: string; envVar: string }> = [
  { key: "finance", displayName: "Finance Agent", envVar: "ZIA_FINANCE_AGENT_ID" },
  { key: "sales-marketing", displayName: "Sales and Marketing Agent", envVar: "ZIA_SALES_MARKETING_AGENT_ID" },
  { key: "compliance-filings", displayName: "Compliance and Filings Agent", envVar: "ZIA_COMPLIANCE_FILINGS_AGENT_ID" },
  { key: "systems-automation", displayName: "Systems and Automation Agent", envVar: "ZIA_SYSTEMS_AUTOMATION_AGENT_ID" },
];

const NUMERIC_AGENT_ID = /^\d+$/;

function optionalAgents(): ZiaAgentDefinition[] {
  const agents: ZiaAgentDefinition[] = [];
  for (const candidate of OPTIONAL_FUNCTION_AGENTS) {
    const agentId = process.env[candidate.envVar]?.trim();
    if (!agentId) continue;
    if (!NUMERIC_AGENT_ID.test(agentId)) {
      console.error(
        `[agents] ${candidate.envVar} is set but is not a numeric Zia agent id; ${candidate.displayName} stays unregistered.`
      );
      continue;
    }
    agents.push({ key: candidate.key, displayName: candidate.displayName, agentId });
  }
  return agents;
}

export const ZIA_AGENTS: Record<string, ZiaAgentDefinition> = {
  [SENIOR_PROJECTS_MANAGER.key]: SENIOR_PROJECTS_MANAGER,
  ...Object.fromEntries(optionalAgents().map((agent) => [agent.key, agent])),
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

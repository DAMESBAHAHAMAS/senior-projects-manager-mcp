/**
 * Channel-to-agent routing table — the one place that decides which Zia agent
 * answers in which chat channel. The table is chat-platform neutral: a key is
 * "<source>:<conversation id>", so a Zoho Cliq or Connect adapter later adds
 * rows here without touching the router.
 *
 * A route is ACTIVE only when its agent key is registered in agents.ts. A
 * function whose agent has not been deployed yet keeps its row here but stays
 * inactive, so seeding the agent and setting its env var is all it takes to
 * switch the channel on.
 *
 * Extra rows (for example a project channel) can be added without a deploy
 * through CHANNEL_ROUTES_JSON, a JSON object of the same shape:
 *   {"slack:C0123456789": {"agentKey": "finance", "label": "Finance"}}
 * Env rows override code rows with the same key.
 */

import { ZIA_AGENTS } from "../agents.js";

export type ChatSource = "slack";

export interface ChannelRoute {
  /** Registry key of the Zia agent that answers in this channel (agents.ts). */
  agentKey: string;
  /** Plain-language function or project name, used in neutral failure replies. */
  label: string;
}

/** Slack channel ids are stable; channel names can change, so never route by name. */
const CODE_ROUTES: Record<string, ChannelRoute> = {
  "slack:C0C60NJRTQQ": { agentKey: "senior-projects-manager", label: "Business Operations" }, // #fn-business-ops
  "slack:C0C54DTSNUW": { agentKey: "finance", label: "Finance" }, // #fn-finance
  "slack:C0C54E4PQQ6": { agentKey: "sales-marketing", label: "Sales and Marketing" }, // #fn-sales-marketing
  "slack:C0C4R1JK70F": { agentKey: "compliance-filings", label: "Compliance and Filings" }, // #fn-compliance
  "slack:C0C58B5PY57": { agentKey: "systems-automation", label: "Systems and Automation" }, // #fn-systems
};

function envRoutes(): Record<string, ChannelRoute> {
  const raw = process.env.CHANNEL_ROUTES_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ChannelRoute>>;
    const routes: Record<string, ChannelRoute> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.agentKey === "string" && typeof value.label === "string") {
        routes[key] = { agentKey: value.agentKey, label: value.label };
      } else {
        console.error(`[routes] CHANNEL_ROUTES_JSON row "${key}" is missing agentKey or label; ignored.`);
      }
    }
    return routes;
  } catch {
    console.error("[routes] CHANNEL_ROUTES_JSON is not valid JSON; env routes ignored.");
    return {};
  }
}

const ALL_ROUTES: Record<string, ChannelRoute> = { ...CODE_ROUTES, ...envRoutes() };

export function routeKey(source: ChatSource, conversationId: string): string {
  return `${source}:${conversationId}`;
}

/** The route for a conversation, or undefined when the conversation is not routed. */
export function findRoute(source: ChatSource, conversationId: string): ChannelRoute | undefined {
  return ALL_ROUTES[routeKey(source, conversationId)];
}

/** True when the route's agent is registered, i.e. the channel will actually be answered. */
export function isRouteActive(route: ChannelRoute): boolean {
  return Boolean(ZIA_AGENTS[route.agentKey]);
}

/** One line per route with its state, logged at startup so the live table is visible in the host logs. */
export function describeRoutes(): string[] {
  return Object.entries(ALL_ROUTES).map(
    ([key, route]) => `${key} -> ${route.agentKey} (${route.label}) ${isRouteActive(route) ? "ACTIVE" : "inactive: agent not registered"}`
  );
}

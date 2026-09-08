/**
 * Environment-driven configuration. Every value here can be overridden by an
 * env var so the same image runs unchanged in local dev and in the cloud.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  zoho: {
    tokenUrl: process.env.ZOHO_TOKEN_URL ?? "https://accounts.zoho.com/oauth/v2/token",
    clientId: () => requireEnv("ZOHO_CLIENT_ID"),
    clientSecret: () => requireEnv("ZOHO_CLIENT_SECRET"),
    refreshToken: () => requireEnv("ZOHO_REFRESH_TOKEN"),
  },
  ziaAgent: {
    // Base of the Zia Agents trigger API. The gateway appends /{agentId}/trigger
    // for whichever agent a call targets — see agents.ts for the agent registry.
    baseUrl: process.env.ZIA_AGENT_BASE_URL ?? "https://ziaagents.zoho.com/ziaagents/api/v1/agents",
    orgId: process.env.ZIA_AGENT_ORG_ID ?? "933376281",
    // Optional pinned Zia conversation session. Left unset (the normal case),
    // every call gets a fresh numeric session id — see newZiaSessionId() in
    // zohoZiaClient.ts — so independent requests don't replay one another's
    // accumulated history into the model context. Zia requires this header to
    // be numeric: a value containing letters is rejected with
    // HTTP 400 INVALID_SESSION_ID.
    sessionId: process.env.ZIA_AGENT_SESSION_ID,
  },
  server: {
    port: parseInt(process.env.PORT ?? "3000", 10),
    // Host used only to select the SDK's built-in DNS-rebinding host-header
    // validation strategy (see createMcpExpressApp in index.ts) — not the
    // actual bind address. Defaults to "0.0.0.0" (no host-header
    // restriction, matching a server reachable through a cloud host's own
    // domain). Set MCP_ALLOWED_HOSTS once a deployment hostname is known to
    // enable strict validation.
    host: process.env.MCP_HTTP_HOST ?? "0.0.0.0",
    allowedHosts: process.env.MCP_ALLOWED_HOSTS
      ? process.env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
      : undefined,
    // Bearer token required on incoming MCP requests. Required in production
    // (NODE_ENV=production) since this endpoint triggers live business
    // agents with write access to Projects/CRM/WorkDrive. Optional locally.
    apiKey: process.env.MCP_SERVER_API_KEY,
  },
};

export function assertConfigured(): void {
  config.zoho.clientId();
  config.zoho.clientSecret();
  config.zoho.refreshToken();

  if (process.env.NODE_ENV === "production" && !config.server.apiKey) {
    throw new Error(
      "MCP_SERVER_API_KEY must be set when NODE_ENV=production — this server " +
        "triggers a live Zoho Projects agent and must not be left open to the internet."
    );
  }
}

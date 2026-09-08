# senior-projects-manager-mcp-server

Remote MCP server ("gateway") for triggering deployed Zoho Zia agents. The
gateway itself — OAuth, HTTP client, MCP transport — is agent-independent;
which agent a call reaches is resolved through the registry in
[`src/agents.ts`](src/agents.ts). It currently exposes one tool,
`ask_senior_projects_manager`, whose default (and only currently registered)
target is the deployed Zoho Zia **Senior Projects Manager** agent (portal
`damianknowles`, agent id `20971000000021961`), reached via its `/trigger`
API.

Reference implementation: `~/zia-agent/zia_agent.py` (interactive CLI script
this server generalizes into a long-running HTTP service).

## Architecture

- **`src/agents.ts`** — registry of addressable Zia agents (key → display name
  → numeric agent id). Adding a new agent means adding an entry here, not
  touching the client or transport. `DEFAULT_ZIA_AGENT_KEY` (env
  `ZIA_DEFAULT_AGENT`, defaults to `senior-projects-manager`) picks the agent
  used when a call doesn't name one.
- **`src/zohoZiaClient.ts`** — agent-independent client: Zoho OAuth token
  refresh/caching, and `triggerZiaAgent(message, agentKey?)` which resolves
  `agentKey` through the registry and POSTs to that agent's trigger URL. Has
  no built-in knowledge of the Senior Projects Manager specifically.
- **`src/index.ts`** — MCP server/transport plumbing plus the one registered
  tool, which is a thin wrapper: `agent` param → `triggerZiaAgent`.

## Tool

### `ask_senior_projects_manager`

| Field | Type | Description |
|---|---|---|
| `message` | string | Natural-language request, e.g. `"What should I work on next?"` |
| `agent` | string, optional | Registry key of the agent to address. Defaults to `senior-projects-manager`. An unrecognized key returns an error listing the known keys rather than silently falling back. |

Returns the agent's plain-text response. Because the underlying agent has
write access to Zoho Projects (and limited access to Mail/CRM/WorkDrive),
calls that ask it to create or change records will actually do so, subject to
the agent's own confirmation rules (see its instructions/guardrails in Zia
Agent Studio).

## Local development

```bash
npm install
cp .env.example .env   # fill in ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN
npm run dev
```

By default the server speaks streamable HTTP on `POST http://localhost:3000/mcp`
(health check at `GET /healthz`). Set `TRANSPORT=stdio` to run it as a local
stdio MCP server instead (for e.g. the Claude Desktop config).

The HTTP transport uses the MCP TypeScript SDK's current recommended
stateless pattern: `StreamableHTTPServerTransport` with
`sessionIdGenerator: undefined` (no session state kept between requests —
each `POST /mcp` is fully self-contained) and a fresh `McpServer` per
request, built via the SDK's `createMcpExpressApp()` helper (JSON body
parsing plus optional DNS-rebinding host validation, see `MCP_ALLOWED_HOSTS`
above).

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Required | Notes |
|---|---|---|
| `ZOHO_CLIENT_ID` | yes | Zoho self-client OAuth credentials |
| `ZOHO_CLIENT_SECRET` | yes | |
| `ZOHO_REFRESH_TOKEN` | yes | |
| `ZOHO_TOKEN_URL` | no | Defaults to `https://accounts.zoho.com/oauth/v2/token` |
| `ZIA_AGENT_BASE_URL` | no | Defaults to `https://ziaagents.zoho.com/ziaagents/api/v1/agents`; the gateway appends `/{agentId}/trigger` per call |
| `ZIA_AGENT_ORG_ID` | no | Defaults to `933376281` |
| `ZIA_AGENT_SESSION_ID` | no | Defaults to `10000` |
| `ZIA_SENIOR_PROJECTS_MANAGER_AGENT_ID` | no | Overrides the Senior Projects Manager's numeric agent id (default `20971000000021961`) |
| `ZIA_DEFAULT_AGENT` | no | Registry key used when a call omits `agent`. Defaults to `senior-projects-manager` |
| `MCP_SERVER_API_KEY` | required in production | Bearer token clients must send to `POST /mcp`. The server refuses to start with `NODE_ENV=production` and no key set. |
| `MCP_HTTP_HOST` | no | Selects the SDK's DNS-rebinding host-validation mode (not the actual bind address). Defaults to `0.0.0.0` (no restriction). |
| `MCP_ALLOWED_HOSTS` | no | Comma-separated allowed `Host` header values. Set once a deployment hostname is known to enable strict validation. |
| `PORT` | no | Defaults to `3000`; most PaaS providers inject this |
| `TRANSPORT` | no | `http` (default) or `stdio` |

Access tokens are refreshed from the Zoho refresh token on demand and cached
in memory until ~1 minute before expiry.

### Registering another agent

To make the gateway able to address a second Zia agent (e.g. the Inbox
Execution Agent), add an entry to the `ZIA_AGENTS` map in `src/agents.ts`
with its key, display name, and numeric agent id — no changes needed in the
client or transport layers. Callers then pass that key as the tool's `agent`
argument; omitting it keeps using the default.

## Connecting an MCP client

Once deployed, point a remote-MCP-capable client at:

```
https://<your-deployment-host>/mcp
```

with header `Authorization: Bearer <MCP_SERVER_API_KEY>`.

## Cloud deployment

### Docker

```bash
docker build -t senior-projects-manager-mcp-server .
docker run -p 3000:3000 \
  -e ZOHO_CLIENT_ID=... \
  -e ZOHO_CLIENT_SECRET=... \
  -e ZOHO_REFRESH_TOKEN=... \
  -e MCP_SERVER_API_KEY=... \
  -e NODE_ENV=production \
  senior-projects-manager-mcp-server
```

### Render

`render.yaml` defines a Blueprint web service (`npm install && npm run build`
/ `npm start`, health check on `/healthz`). The four secret env vars
(`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`,
`MCP_SERVER_API_KEY`) are marked `sync: false` — set them in the Render
dashboard rather than committing them.

Any other Node-friendly host (Fly.io, Railway, a plain VM, etc.) works the
same way: build with `npm install && npm run build`, run `npm start`, and set
the same environment variables.

## Security note

This server triggers a live business agent with write access to a real Zoho
Projects portal, CRM notes, and WorkDrive uploads. Do not deploy it without
`MCP_SERVER_API_KEY` set, and treat that key like any other credential.

#!/usr/bin/env node
/**
 * Remote MCP server ("gateway") for triggering deployed Zoho Zia agents.
 * The gateway itself is agent-independent — OAuth, HTTP transport, and MCP
 * plumbing know nothing about any specific agent; see agents.ts for the
 * registry of addressable agents. It currently exposes one tool,
 * ask_senior_projects_manager, whose default (and only currently
 * registered) target is the Senior Projects Manager agent.
 */

import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { DEFAULT_ZIA_AGENT_KEY, ZIA_AGENTS } from "./agents.js";
import { assertConfigured, config } from "./config.js";
import { resolveZiaSessionId, triggerZiaAgent } from "./zohoZiaClient.js";

const AskSeniorProjectsManagerInputSchema = z
  .object({
    message: z
      .string()
      .min(1, "message must not be empty")
      .max(8000, "message must not exceed 8000 characters")
      .describe(
        "A natural-language request or question for the target agent, " +
          "e.g. 'What should I work on next?' or 'What's next in DK-152 specifically?'"
      ),
    agent: z
      .string()
      .optional()
      .describe(
        `Which registered Zia agent to address, by key. Defaults to "${DEFAULT_ZIA_AGENT_KEY}" ` +
          `(the Senior Projects Manager) when omitted. Known agents: ${Object.keys(ZIA_AGENTS).join(", ")}.`
      ),
    session: z
      .string()
      .regex(/^\d+$/, "session must contain digits only")
      .optional()
      .describe(
        "Zia conversation session id, digits only. Omit for an independent " +
          "one-shot request: a fresh session is generated so none of the " +
          "agent's earlier turns are replayed into this call. Pass back the " +
          "sessionId returned by a previous call only when this request " +
          "genuinely depends on that conversation — reusing a session across " +
          "unrelated requests grows the context and the token cost of every " +
          "subsequent turn."
      ),
  })
  .strict();

type AskSeniorProjectsManagerInput = z.infer<typeof AskSeniorProjectsManagerInputSchema>;

function buildServer(): McpServer {
  const server = new McpServer({
    name: "senior-projects-manager-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "ask_senior_projects_manager",
    {
      title: "Ask Senior Projects Manager",
      description: `Send a natural-language message to a deployed Zia agent through this gateway and return its response. Defaults to the Senior Projects Manager agent.

The Senior Projects Manager operates the damianknowles Zoho Projects portal (and has read/limited-write access to Mail, CRM and WorkDrive). It determines what to work on next, ranks the actionable frontier, and can create/update projects, phases, task lists, tasks, dependencies, issues and time logs.

Args:
  - message (string): The natural-language request, e.g. "What should I work on next?", "What's next in DK-152?", or "Log 2 hours against <task> for yesterday."
  - agent (string, optional): Which registered agent to address, by key. Defaults to the Senior Projects Manager. See the schema description for currently known keys.
  - session (string, optional): Numeric Zia session id. Omit unless continuing an earlier exchange.

Returns:
  The agent's plain-text response, plus the sessionId the call ran under.

Notes:
  - This calls a live, stateful business agent — write requests (creating tasks, logging time, etc.) will actually be performed by the agent according to its own confirmation rules.
  - By default each call runs in its own fresh Zia session, so it carries no history from previous calls. To continue a multi-turn task, pass the sessionId returned by the previous call back in as session.
  - Passing an unregistered agent key returns an error listing the known keys instead of failing silently.`,
      inputSchema: AskSeniorProjectsManagerInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ message, agent, session }: AskSeniorProjectsManagerInput) => {
      try {
        // Resolved here rather than inside the client so the id can be
        // reported back to the caller for deliberate multi-turn reuse.
        const sessionId = resolveZiaSessionId(session);
        const result = await triggerZiaAgent(message, agent, sessionId);
        const text = result?.data?.response;

        if (!text) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent call succeeded but returned no response text. Raw payload: ${JSON.stringify(
                  result
                )}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { response: text, sessionId },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.server.apiKey) {
    // No key configured (local/dev use only — assertConfigured() blocks this in production).
    next();
    return;
  }

  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const expected = Buffer.from(config.server.apiKey);
  const actual = Buffer.from(presented);
  const authorized =
    expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!authorized) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

async function runHttp(): Promise<void> {
  // SDK-provided app factory (current recommended pattern): wires up JSON
  // body parsing and, when configured, DNS-rebinding host-header
  // validation. See config.server.host / MCP_ALLOWED_HOSTS.
  const app = createMcpExpressApp({
    host: config.server.host,
    allowedHosts: config.server.allowedHosts,
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", requireApiKey, async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(config.server.port, () => {
    console.error(
      `senior-projects-manager-mcp-server listening on port ${config.server.port} (POST /mcp)`
    );
  });
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("senior-projects-manager-mcp-server running via stdio");
}

assertConfigured();

const transportMode = process.env.TRANSPORT ?? "http";
const run = transportMode === "stdio" ? runStdio() : runHttp();

run.catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

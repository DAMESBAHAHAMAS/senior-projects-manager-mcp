/**
 * Thin, agent-independent client for the Zoho Zia Agent "trigger" API,
 * mirroring the reference implementation in zia_agent.py: refresh-token
 * OAuth against Zoho accounts, then POST the natural-language query to a
 * deployed agent's trigger URL. Which agent is addressed is resolved via
 * agents.ts and passed in per call — this module has no agent-specific
 * knowledge of its own.
 */

import axios, { AxiosError } from "axios";
import { resolveZiaAgent } from "./agents.js";
import { config } from "./config.js";

interface ZohoTokenResponse {
  access_token?: string;
  error?: string;
  [key: string]: unknown;
}

export interface ZiaAgentResponse {
  data?: {
    response?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Zia requires the X-ZIAAGENTS-AGENT-SESSION-ID header to be numeric; a value
 * containing letters is rejected with HTTP 400 INVALID_SESSION_ID. Verified
 * accepted against the live API at 5, 10, 13 and 16 digits.
 */
const NUMERIC_SESSION_ID = /^\d+$/;

/**
 * A fresh session id for an independent request. Millisecond epoch plus a
 * three-digit random suffix (16 digits, a verified-accepted length) so two
 * calls landing in the same millisecond don't share a Zia conversation.
 */
export function newZiaSessionId(): string {
  const suffix = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${Date.now()}${suffix}`;
}

/**
 * Resolve which Zia session a call should use. Precedence: an explicit id from
 * the caller (genuine multi-turn work on one task) > a deployment-wide pin via
 * ZIA_AGENT_SESSION_ID > a fresh session (the default for independent calls).
 * Exported so callers can report the id they used and pass it back on a
 * follow-up turn.
 */
export function resolveZiaSessionId(explicit?: string): string {
  const sessionId = explicit ?? config.ziaAgent.sessionId ?? newZiaSessionId();
  if (!NUMERIC_SESSION_ID.test(sessionId)) {
    throw new Error(
      `Invalid Zia session id "${sessionId}": must contain digits only. ` +
        "Zia rejects non-numeric session ids with HTTP 400 INVALID_SESSION_ID."
    );
  }
  return sessionId;
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

/** Refresh tokens are long-lived; access tokens expire in ~1h. Refresh a
 * little early and re-fetch on demand rather than trusting a fixed TTL. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const params = new URLSearchParams({
    client_id: config.zoho.clientId(),
    client_secret: config.zoho.clientSecret(),
    grant_type: "refresh_token",
    refresh_token: config.zoho.refreshToken(),
  });

  let response;
  try {
    response = await axios.post<ZohoTokenResponse>(config.zoho.tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
    });
  } catch (error) {
    throw new Error(`Zoho OAuth token refresh failed: ${describeError(error)}`);
  }

  const accessToken = response.data.access_token;
  if (!accessToken) {
    throw new Error(
      `Zoho did not return an access token: ${JSON.stringify(response.data)}`
    );
  }

  // Zoho does not echo expires_in on every grant call reliably; assume the
  // standard 1 hour lifetime and refresh a minute early.
  const expiresInMs = (Number(response.data.expires_in) || 3600) * 1000;
  cachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresInMs - TOKEN_SAFETY_MARGIN_MS,
  };

  return accessToken;
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError;
    if (err.response) {
      return `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`;
    }
    if (err.code === "ECONNABORTED") {
      return "request timed out";
    }
    return err.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Invoke a deployed Zia agent with a natural language message and return its
 * full response payload. `agentKey` selects which registered agent to call
 * (see agents.ts); omitting it uses the gateway's default agent. `sessionId`
 * pins the Zia conversation session; omitting it starts a fresh one so the
 * call carries no prior history.
 */
export async function triggerZiaAgent(
  message: string,
  agentKey?: string,
  sessionId?: string
): Promise<ZiaAgentResponse> {
  const agent = resolveZiaAgent(agentKey);
  const session = resolveZiaSessionId(sessionId);
  const accessToken = await getAccessToken();
  const triggerUrl = `${config.ziaAgent.baseUrl}/${agent.agentId}/trigger`;

  const payload = {
    query: message,
    reasoning: false,
    attachments: [],
    systemArgs: {},
  };

  try {
    const response = await axios.post<ZiaAgentResponse>(triggerUrl, payload, {
      headers: {
        "X-ZIAAGENTS-ORG": config.ziaAgent.orgId,
        "X-ZIAAGENTS-AGENT-SESSION-ID": session,
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 120_000,
    });
    return response.data;
  } catch (error) {
    throw new Error(
      `Zia agent "${agent.displayName}" trigger call failed: ${describeError(error)}`
    );
  }
}

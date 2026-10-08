/**
 * Slack adapter for the chat-neutral router (router.ts).
 *
 * Slack -> POST /slack/events (Events API, message.channels)
 *   1. Verify Slack's request signature against SLACK_SIGNING_SECRET.
 *   2. Answer Slack within its 3-second window, then work asynchronously.
 *   3. Route only messages a person typed by hand: an allowlisted sender,
 *      no bot, no app, no agent attribution. Agent posts made through
 *      Damian's own account (ChatGPT, Claude connectors) never trigger an
 *      agent, so canon notices and agent-to-agent traffic cannot loop.
 *   4. Thread replies route only when the thread's first message was itself
 *      a routed, hand-typed message.
 *   5. Reply in the same thread as the bot, under the agent's display name.
 *
 * Configuration (Render environment variables — record locations, never values):
 *   SLACK_BOT_TOKEN          Bot User OAuth Token of the Slack app
 *   SLACK_SIGNING_SECRET     Signing Secret of the Slack app
 *   ROUTER_ALLOWED_USERS     Comma-separated Slack user ids allowed to trigger agents
 *                            (default: Damian, U08FY0GQ9G8)
 *   SLACK_OPS_ALERT_CHANNEL  Optional channel id for failure detail (e.g. #agent-ops)
 */

import express, { Request, Response, Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import axios from "axios";
import { handleInbound, InboundMessage, ReplyPort } from "./router.js";
import { activeConversationIds, findRoute } from "./routes.js";
import { handleIntake, intakeConfig, IntakeDeps, IntakeEvent, ThreadMessage } from "./intake.js";
import { readHandoff } from "../haikuClient.js";
import { askOpenAI } from "../openaiClient.js";

const SLACK_API = "https://slack.com/api";
const DEFAULT_ALLOWED_USERS = "U08FY0GQ9G8";
const MAX_SIGNATURE_AGE_SECONDS = 60 * 5;
const DEDUPE_TTL_MS = 60 * 60 * 1000;
const THREAD_CACHE_LIMIT = 2000;
/** Slack's markdown block takes up to 12,000 characters; leave headroom. */
const REPLY_CHUNK_CHARS = 11_000;

/** Message subtypes a person can produce by typing. Everything else (edits, joins, bot posts) is ignored. */
const HUMAN_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);
/** Attribution Slack shows on posts an app made through a person's account ("Sent using ChatGPT"). */
const AGENT_ATTRIBUTION = /\bsent using\b/i;
/** A message that opens with an unresolved "@name", optionally inside backticks or quotes. */
const PLAIN_AT_MENTION = /^[\s`'"*_~(]*@[A-Za-z]/;

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  app_id?: string;
  bot_profile?: unknown;
}

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackMessageEvent;
}

function slackConfig() {
  return {
    botToken: process.env.SLACK_BOT_TOKEN?.trim() || undefined,
    signingSecret: process.env.SLACK_SIGNING_SECRET?.trim() || undefined,
    allowedUsers: new Set(
      (process.env.ROUTER_ALLOWED_USERS ?? DEFAULT_ALLOWED_USERS)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
    opsAlertChannel: process.env.SLACK_OPS_ALERT_CHANNEL?.trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Slack request signing v0: HMAC-SHA256 of "v0:{timestamp}:{raw body}". */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack ts "1791179540.154649" -> "1791179540154649": numeric, 16 digits, stable per thread. */
export function sessionKeyFromTs(ts: string): string {
  const digits = ts.replace(".", "");
  if (!/^\d+$/.test(digits)) {
    throw new Error(`Unexpected Slack ts format: ${ts}`);
  }
  return digits;
}

/** Why a message must not trigger an agent, or null when a person typed it and may trigger one. */
export function humanSkipReason(event: SlackMessageEvent, allowedUsers: Set<string>): string | null {
  if (event.type !== "message") return "not-a-message";
  if (!HUMAN_SUBTYPES.has(event.subtype)) return `subtype:${event.subtype}`;
  if (event.bot_id || event.bot_profile) return "bot-post";
  if (event.app_id) return "app-post";
  if (!event.user || !allowedUsers.has(event.user)) return "sender-not-allowlisted";
  if (!event.text || !event.text.trim()) return "empty-text";
  if (/<@[A-Z0-9]+>/.test(event.text)) return "explicit-mention";
  // Typed or pasted "@ChatGPT ..." that Slack did not resolve (code span, plain paste) still addresses another app.
  if (PLAIN_AT_MENTION.test(event.text)) return "plain-at-mention";
  if (AGENT_ATTRIBUTION.test(event.text)) return "agent-attribution";
  return null;
}

/** Split long agent answers into Slack-sized pieces, preferring paragraph breaks. */
export function chunkText(text: string, limit: number = REPLY_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Minimal Markdown -> Slack mrkdwn, used only for the plain-text fallback. */
export function toMrkdwn(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
}

export class TtlSet {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}

  /** True the first time a key is offered inside the TTL window; false for repeats. */
  firstSighting(key: string, now: number = Date.now()): boolean {
    for (const [k, expiry] of this.seen) {
      if (expiry > now) break;
      this.seen.delete(k);
    }
    const expiry = this.seen.get(key);
    if (expiry && expiry > now) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Slack Web API
// ---------------------------------------------------------------------------

async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  httpMethod: "POST" | "GET" = "POST"
): Promise<T> {
  const url = `${SLACK_API}/${method}`;
  const response =
    httpMethod === "GET"
      ? await axios.get(url, {
          params: body,
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15_000,
        })
      : await axios.post(url, body, {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          timeout: 15_000,
        });
  const data = response.data as { ok?: boolean; error?: string };
  if (!data?.ok) {
    throw new Error(`Slack ${method} failed: ${data?.error ?? "unknown error"}`);
  }
  return response.data as T;
}

async function postInThread(
  token: string,
  channel: string,
  threadTs: string,
  text: string,
  senderName: string
): Promise<void> {
  for (const chunk of chunkText(text)) {
    try {
      // Preferred: Slack's markdown block renders standard Markdown from the agent as written.
      await slackApi(token, "chat.postMessage", {
        channel,
        thread_ts: threadTs,
        text: toMrkdwn(chunk),
        blocks: [{ type: "markdown", text: chunk }],
        username: senderName,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (first) {
      // Degraded path: plain mrkdwn text, default bot name. Covers a rejected
      // block or a missing chat:write.customize scope.
      console.error(JSON.stringify({ evt: "slack", step: "postMessage-fallback", detail: String(first) }));
      await slackApi(token, "chat.postMessage", {
        channel,
        thread_ts: threadTs,
        text: toMrkdwn(chunk),
        unfurl_links: false,
        unfurl_media: false,
      });
    }
  }
}

function slackReplyPort(token: string, event: SlackMessageEvent, threadTs: string, opsAlertChannel?: string): ReplyPort {
  const react = (name: string, add: boolean) =>
    slackApi(token, add ? "reactions.add" : "reactions.remove", {
      channel: event.channel,
      timestamp: event.ts,
      name,
    }).then(() => undefined);

  return {
    received: () => react("eyes", true),
    reply: (text, senderName) => postInThread(token, event.channel, threadTs, text, senderName),
    finished: async (ok) => {
      await react("eyes", false).catch(() => undefined);
      await react(ok ? "white_check_mark" : "warning", true);
    },
    alertOps: opsAlertChannel
      ? (detail) =>
          slackApi(token, "chat.postMessage", {
            channel: opsAlertChannel,
            text: `TYPE: Failure\n${detail}\nOWNER: Systems and Automation`,
            unfurl_links: false,
          }).then(() => undefined)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Thread rule: replies route only inside threads a person started
// ---------------------------------------------------------------------------

const threadRootCache = new Map<string, boolean>();

async function threadRootIsHuman(
  token: string,
  channel: string,
  threadTs: string,
  allowedUsers: Set<string>
): Promise<boolean> {
  const key = `${channel}:${threadTs}`;
  const cached = threadRootCache.get(key);
  if (cached !== undefined) return cached;

  const data = await slackApi<{ messages?: SlackMessageEvent[] }>(
    token,
    "conversations.replies",
    { channel, ts: threadTs, limit: 1, inclusive: true },
    "GET"
  );
  const root = data.messages?.[0];
  const human = Boolean(root && root.ts === threadTs && humanSkipReason({ ...root, type: "message", channel }, allowedUsers) === null);

  if (threadRootCache.size >= THREAD_CACHE_LIMIT) {
    const oldest = threadRootCache.keys().next().value;
    if (oldest !== undefined) threadRootCache.delete(oldest);
  }
  threadRootCache.set(key, human);
  return human;
}

// ---------------------------------------------------------------------------
// Auto-join: the bot joins every public channel whose route is ACTIVE
// ---------------------------------------------------------------------------

/**
 * Join each routed channel whose agent is registered. Runs at startup, and
 * Render restarts the service on every env change, so setting an agent id
 * (e.g. ZIA_FINANCE_AGENT_ID) or adding a CHANNEL_ROUTES_JSON row brings the
 * bot into that channel with no manual invite. Needs the channels:join scope
 * and works for public channels only; a private channel still needs an invite.
 * Never throws: a failed join is logged and the service keeps running.
 */
export async function joinActiveSlackChannels(): Promise<void> {
  const { botToken } = slackConfig();
  if (!botToken) {
    log({ step: "auto-join", outcome: "skipped", reason: "SLACK_BOT_TOKEN not set" });
    return;
  }
  // Intake channels too, when the relay is on: Slack only sends events for channels the bot is in.
  const intake = intakeConfig(new Set());
  const channels = new Set([...activeConversationIds("slack"), ...(intake.enabled ? intake.channels : [])]);
  for (const channel of channels) {
    try {
      await slackApi(botToken, "conversations.join", { channel });
      log({ step: "auto-join", channel, outcome: "joined" });
    } catch (error) {
      log({ step: "auto-join", channel, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// Express route
// ---------------------------------------------------------------------------

const seenEvents = new TtlSet(DEDUPE_TTL_MS);

function log(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ evt: "slack", ...fields }));
}

const intakeSeen = new TtlSet(DEDUPE_TTL_MS);
let selfIdentity: { userId?: string; botId?: string } | undefined;

function intakeDeps(token: string, channel: string): IntakeDeps {
  return {
    isSelf: async (e) => {
      if (!selfIdentity) {
        try {
          const me = await slackApi<{ user_id?: string; bot_id?: string }>(token, "auth.test", {});
          selfIdentity = { userId: me.user_id, botId: me.bot_id };
        } catch (error) {
          // The relay-line prefix guard still stops loops if identity cannot be read.
          log({ evt: "intake", step: "auth.test", outcome: "failed", detail: String(error) });
          return false;
        }
      }
      return Boolean((e.user && e.user === selfIdentity.userId) || (e.bot_id && e.bot_id === selfIdentity.botId));
    },
    readHandoff,
    post: (threadTs, text) => postInThread(token, channel, threadTs, text, "DK Operations"),
    threadMessages: async (threadTs): Promise<ThreadMessage[]> => {
      const data = await slackApi<{ messages?: { user?: string; bot_id?: string; text?: string }[] }>(
        token,
        "conversations.replies",
        { channel, ts: threadTs, limit: 50 },
        "GET"
      );
      return (data.messages ?? [])
        .filter((m) => m.text)
        .map((m) => ({ who: m.bot_id ? "Bot" : m.user ?? "Unknown", text: m.text as string }));
    },
    askGpt: askOpenAI,
    firstSighting: (key) => intakeSeen.firstSighting(key),
    log,
  };
}

async function processEvent(envelope: SlackEnvelope): Promise<void> {
  const cfg = slackConfig();
  const event = envelope.event;
  const eventId = envelope.event_id ?? "unknown";
  if (!event) return;

  if (!seenEvents.firstSighting(eventId)) {
    log({ id: eventId, decision: "skip", reason: "duplicate-delivery" });
    return;
  }

  // Intake relay: handoff posts ("TO: <function>") get an intake line. Runs ahead of the
  // routing and skip rules below, which would otherwise drop agent-posted handoffs.
  if (cfg.botToken) {
    const intake = await handleIntake(event as IntakeEvent, intakeConfig(cfg.allowedUsers), intakeDeps(cfg.botToken, event.channel));
    if (intake !== "not-intake") return;
  }

  const route = findRoute("slack", event.channel);
  if (!route) {
    log({ id: eventId, channel: event.channel, decision: "skip", reason: "channel-not-routed" });
    return;
  }

  const reason = humanSkipReason(event, cfg.allowedUsers);
  if (reason) {
    log({ id: eventId, channel: event.channel, decision: "skip", reason });
    return;
  }

  if (!cfg.botToken) {
    log({ id: eventId, channel: event.channel, decision: "skip", reason: "SLACK_BOT_TOKEN not set" });
    return;
  }

  const threadTs = event.thread_ts ?? event.ts;
  if (event.thread_ts && event.thread_ts !== event.ts) {
    const human = await threadRootIsHuman(cfg.botToken, event.channel, event.thread_ts, cfg.allowedUsers);
    if (!human) {
      log({ id: eventId, channel: event.channel, decision: "skip", reason: "thread-not-started-by-person" });
      return;
    }
  }

  const message: InboundMessage = {
    source: "slack",
    conversationId: event.channel,
    sessionKey: sessionKeyFromTs(threadTs),
    text: event.text ?? "",
    messageRef: `slack:${event.channel}:${event.ts}`,
  };
  log({ id: eventId, channel: event.channel, decision: "route", agent: route.agentKey, chars: message.text.length });
  const outcome = await handleInbound(message, slackReplyPort(cfg.botToken, event, threadTs, cfg.opsAlertChannel));
  log({ id: eventId, channel: event.channel, decision: "done", outcome });
}

export function slackEventsRouter(): Router {
  const router = express.Router();

  // Raw body is required: the signature covers the exact bytes Slack sent.
  router.post("/slack/events", express.raw({ type: "*/*", limit: "1mb" }), (req: Request, res: Response) => {
    const cfg = slackConfig();
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(rawBody) as SlackEnvelope;
    } catch {
      res.status(400).json({ error: "Bad request" });
      return;
    }

    if (cfg.signingSecret) {
      const valid = verifySlackSignature(
        cfg.signingSecret,
        req.header("x-slack-request-timestamp"),
        rawBody,
        req.header("x-slack-signature")
      );
      if (!valid) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    } else if (envelope.type !== "url_verification") {
      // Setup window only: before the signing secret is installed, the route
      // answers Slack's URL check and nothing else. No event is processed.
      res.status(503).json({ error: "Not configured" });
      return;
    }

    if (envelope.type === "url_verification") {
      res.status(200).json({ challenge: String(envelope.challenge ?? "") });
      return;
    }

    // Acknowledge inside Slack's 3-second window; the agent call can take a minute or more.
    res.status(200).end();

    if (envelope.type === "event_callback") {
      processEvent(envelope).catch((error) => {
        log({ id: envelope.event_id, decision: "error", detail: error instanceof Error ? error.message : String(error) });
      });
    }
  });

  return router;
}

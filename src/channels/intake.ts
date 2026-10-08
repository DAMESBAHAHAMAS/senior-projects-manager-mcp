/**
 * Intake relay: one handoff post in, one honest intake line out, same thread.
 *
 *   A Claude session posts in an intake channel (default #agent-ops):
 *       TO: Finance
 *       FROM: Systems & Automation
 *       <the request>
 *   DK Operations has Claude Haiku read it and replies in the thread:
 *       Intake: read and queued for Finance. Not yet acknowledged by that session. Request as read: ...
 *
 * Honesty rule: DK Operations only reports what it did (read, queued). Only the
 * destination session may say "Acknowledged". No line posted here contains the
 * words "Acknowledged" or "Received".
 *
 * Handoff detection looks at the first line only. Sender identity is not used as
 * a trigger because Claude sessions may post under a person's own Slack user.
 * Posts addressed to GPT skip Haiku and go to the chat model; its reply is its
 * own acknowledgment.
 *
 * Switch: INTAKE_ACK_ENABLED must be "true". INTAKE_CHANNELS (comma-separated
 * channel ids) defaults to #agent-ops. Everything else in this file is pure so it
 * can be tested without Slack or any API.
 */

import { HaikuResult } from "../haikuClient.js";

export const RECIPIENTS = [
  "Business Operations",
  "Finance",
  "Sales & Marketing",
  "Systems & Automation",
  "Compliance & Filings",
  "GPT",
] as const;
export type Recipient = (typeof RECIPIENTS)[number];

export const DEFAULT_INTAKE_CHANNELS = "C0C20DW4UP5"; // #agent-ops
/** Message subtypes a person (or a person's connector) can produce by typing. */
const POSTED_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);
/** First-line prefixes of lines the relay or a destination writes. Never treated as handoffs. */
const RELAY_LINE_PREFIXES = ["intake:", "intake failed:", "acknowledged by", "gpt:"];

export interface IntakeEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

export interface IntakeConfig {
  enabled: boolean;
  channels: Set<string>;
  allowedUsers: Set<string>;
}

export function intakeConfig(allowedUsers: Set<string>): IntakeConfig {
  return {
    enabled: process.env.INTAKE_ACK_ENABLED?.trim().toLowerCase() === "true",
    channels: new Set(
      (process.env.INTAKE_CHANNELS ?? DEFAULT_INTAKE_CHANNELS)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
    allowedUsers,
  };
}

/** Slack escapes &, < and > in event text. */
export function decodeSlackText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function firstLine(text: string): string {
  return decodeSlackText(text).trim().split(/\r?\n/)[0].trim();
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\band\b/g, "&")
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ")
    .trim();
}

const RECIPIENT_BY_NAME = new Map<string, Recipient>(RECIPIENTS.map((r) => [normalizeName(r), r]));

export function normalizeRecipient(raw: string): Recipient | null {
  return RECIPIENT_BY_NAME.get(normalizeName(raw)) ?? null;
}

export interface Handoff {
  /** Canonical recipient, or null when the name after "TO:" is not recognized. */
  recipient: Recipient | null;
  rawRecipient: string;
}

/** A handoff is a message whose FIRST line starts with "TO:" and a recipient. Anything else is null. */
export function parseHandoff(text: string): Handoff | null {
  const match = /^to:\s*(.+)$/i.exec(firstLine(text));
  if (!match) return null;
  const rawRecipient = match[1].trim();
  return { recipient: normalizeRecipient(rawRecipient), rawRecipient };
}

/** True for the relay's own lines and destination acknowledgments, which must never start anything. */
export function isRelayLine(text: string): boolean {
  const line = firstLine(text).toLowerCase();
  return RELAY_LINE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/** Make a model sentence safe to post: no mentions, and never the words the relay must not claim. */
export function sanitizeSentence(sentence: string): string {
  return sentence
    .replace(/[<>]/g, "")
    .replace(/\backnowledged\b/gi, "confirmed")
    .replace(/\breceived\b/gi, "got")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function readLine(recipient: Recipient, sentence: string): string {
  return `Intake: read and queued for ${recipient}. Not yet acknowledged by that session. Request as read: ${sanitizeSentence(sentence)}`;
}
export function noRequestLine(recipient: Recipient): string {
  return `Intake: read, but no clear request was found. Sender, please restate what you need from ${recipient}.`;
}
export const FAILED_LINE = "Intake failed: DK Operations could not read this post. It has not been queued.";
export function unrecognizedLine(): string {
  return `Intake: recipient not recognized. Use one of: ${RECIPIENTS.join(", ")}`;
}
export const GPT_FAILED_LINE = "GPT did not respond. The message was not delivered.";

export interface ThreadMessage {
  who: string;
  text: string;
}

export interface IntakeDeps {
  /** True when the event is something DK Operations itself posted. */
  isSelf(event: IntakeEvent): Promise<boolean>;
  /** Haiku reads the handoff text. */
  readHandoff(text: string): Promise<HaikuResult>;
  /** Post into the handoff's thread as DK Operations. */
  post(threadTs: string, text: string): Promise<void>;
  /** The messages in the thread so far, oldest first (used for GPT context). */
  threadMessages(threadTs: string): Promise<ThreadMessage[]>;
  /** The chat model answers a prompt. Throws on failure. */
  askGpt(prompt: string): Promise<string>;
  /** First time this channel:ts is offered inside the dedupe window. */
  firstSighting(key: string): boolean;
  log(fields: Record<string, unknown>): void;
}

export type IntakeOutcome =
  | "not-intake" // not for this relay; the caller continues with normal routing
  | "skipped" // recognized as something to ignore; the caller must stop
  | "unrecognized"
  | "read"
  | "no-request"
  | "failed"
  | "gpt-answered"
  | "gpt-failed";

export function gptPrompt(thread: ThreadMessage[]): string {
  const transcript = thread.map((m) => `${m.who}: ${m.text}`).join("\n\n");
  return (
    `This is a Slack thread. The latest message is addressed to you (TO: GPT). ` +
    `Answer it using the earlier messages as context.\n\n${transcript}`
  );
}

export async function handleIntake(event: IntakeEvent, cfg: IntakeConfig, deps: IntakeDeps): Promise<IntakeOutcome> {
  if (!cfg.enabled || !cfg.channels.has(event.channel) || event.type !== "message") return "not-intake";
  const base = { evt: "intake", channel: event.channel, ts: event.ts };

  if (!POSTED_SUBTYPES.has(event.subtype)) {
    deps.log({ ...base, decision: "skip", reason: `subtype:${event.subtype}` });
    return "skipped";
  }
  const text = event.text ?? "";
  if (!text.trim()) return "not-intake";

  if (isRelayLine(text)) {
    deps.log({ ...base, decision: "skip", reason: "relay-line" });
    return "skipped";
  }
  if (await deps.isSelf(event)) {
    deps.log({ ...base, decision: "skip", reason: "own-post" });
    return "skipped";
  }

  const handoff = parseHandoff(text);
  if (!handoff) return "not-intake";

  // Identity fields are logged (never the text) as evidence of how sessions post.
  const identity = { has_user: Boolean(event.user), has_bot_id: Boolean(event.bot_id), subtype: event.subtype ?? null };
  if (event.user && !cfg.allowedUsers.has(event.user)) {
    deps.log({ ...base, ...identity, decision: "skip", reason: "sender-not-allowlisted" });
    return "skipped";
  }
  if (!deps.firstSighting(`${event.channel}:${event.ts}`)) {
    deps.log({ ...base, decision: "skip", reason: "duplicate-message" });
    return "skipped";
  }

  const threadTs = event.thread_ts ?? event.ts;
  const post = async (line: string) => {
    try {
      await deps.post(threadTs, line);
    } catch (error) {
      deps.log({ ...base, step: "post", outcome: "post-error", detail: error instanceof Error ? error.message : String(error) });
    }
  };

  if (!handoff.recipient) {
    deps.log({ ...base, ...identity, decision: "unrecognized-recipient" });
    await post(unrecognizedLine());
    return "unrecognized";
  }

  if (handoff.recipient === "GPT") {
    try {
      const thread = await deps.threadMessages(threadTs);
      const answer = (await deps.askGpt(gptPrompt(thread.length ? thread : [{ who: "Sender", text: decodeSlackText(text) }]))).trim();
      if (!answer) throw new Error("GPT returned no text");
      deps.log({ ...base, ...identity, decision: "gpt", outcome: "answered", chars: answer.length });
      await post(`GPT: ${answer}`);
      return "gpt-answered";
    } catch (error) {
      deps.log({ ...base, ...identity, decision: "gpt", outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
      await post(GPT_FAILED_LINE);
      return "gpt-failed";
    }
  }

  const result = await deps.readHandoff(decodeSlackText(text));
  if (result.kind === "read") {
    deps.log({ ...base, ...identity, decision: "intake", recipient: handoff.recipient, outcome: "read" });
    await post(readLine(handoff.recipient, result.sentence));
    return "read";
  }
  if (result.kind === "no-request") {
    deps.log({ ...base, ...identity, decision: "intake", recipient: handoff.recipient, outcome: "no-request" });
    await post(noRequestLine(handoff.recipient));
    return "no-request";
  }
  deps.log({ ...base, ...identity, decision: "intake", recipient: handoff.recipient, outcome: "failed", detail: result.detail });
  await post(FAILED_LINE);
  return "failed";
}

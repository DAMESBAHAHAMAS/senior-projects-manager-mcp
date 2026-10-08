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

/** "Acknowledged by <function>" on the first line, naming a known function (never GPT). Null otherwise. */
export function parseAck(text: string): Recipient | null {
  const match = /^acknowledged by\s+(.+)$/i.exec(firstLine(text));
  if (!match) return null;
  // A connector may add "*Sent using* <@app>" after the text; it is attribution, not part of the name.
  const name = match[1].replace(/\s*\*?_?sent using(?![a-z]).*$/i, "").trim().replace(/[.!\s]+$/, "");
  const recipient = normalizeRecipient(name);
  return recipient && recipient !== "GPT" ? recipient : null;
}

/** The sender function named on the second line ("FROM: Finance"), or null. */
export function parseFrom(text: string): Recipient | null {
  const line = decodeSlackText(text).trim().split(/\r?\n/)[1]?.trim() ?? "";
  const match = /^from:\s*(.+)$/i.exec(line);
  return match ? normalizeRecipient(match[1]) : null;
}

export interface HistoryMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  /** True when DK Operations itself posted it. */
  self: boolean;
}

export type AckTarget = { kind: "target"; ts: string } | { kind: "none"; reason: string };

/**
 * Which handoff does an acknowledgment from `by`, posted at `ackTs`, answer? It must be the latest
 * handoff addressed to `by` that DK Operations queued, not sent by `by` itself, and not already
 * acknowledged by an earlier valid reply. Pure: the thread is the only state.
 */
export function findAckTarget(history: HistoryMessage[], ackTs: string, by: Recipient, allowedUsers: Set<string>): AckTarget {
  const before = history.filter((m) => Number(m.ts) < Number(ackTs)).sort((a, b) => Number(a.ts) - Number(b.ts));
  const queuedLine = `intake: read and queued for ${by}`.toLowerCase();
  let sawHandoff = false;
  let sawQueued = false;
  for (let i = before.length - 1; i >= 0; i--) {
    const h = before[i];
    if (h.self) continue;
    const parsed = parseHandoff(h.text);
    if (!parsed || parsed.recipient !== by) continue;
    sawHandoff = true;
    const queued = before.some((m) => m.self && Number(m.ts) > Number(h.ts) && firstLine(m.text).toLowerCase().startsWith(queuedLine));
    if (!queued) continue;
    sawQueued = true;
    if (parseFrom(h.text) === by) return { kind: "none", reason: "ack-by-sender-function" };
    const alreadyAcked = before.some(
      (m) => !m.self && Number(m.ts) > Number(h.ts) && parseAck(m.text) === by && (!m.user || allowedUsers.has(m.user))
    );
    return alreadyAcked ? { kind: "none", reason: "already-acknowledged" } : { kind: "target", ts: h.ts };
  }
  return { kind: "none", reason: sawHandoff && !sawQueued ? "handoff-not-queued" : "no-handoff-for-recipient" };
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
  /** Every message in the thread, oldest first, with who posted it (used to find the handoff an acknowledgment answers). */
  threadHistory(threadTs: string): Promise<Omit<HistoryMessage, "self">[]>;
  /** Put the pending marker on a handoff message. */
  markPending(messageTs: string): Promise<void>;
  /** Swap the pending marker for the acknowledged marker. */
  markAcknowledged(messageTs: string): Promise<void>;
  /** The chat model answers a prompt. Throws on failure. */
  askGpt(prompt: string): Promise<string>;
  /** First time this channel:ts is offered inside the dedupe window. */
  firstSighting(key: string): boolean;
  log(fields: Record<string, unknown>): void;
}

export type IntakeOutcome =
  | "not-intake" // not for this relay; the caller continues with normal routing
  | "skipped" // recognized as something to ignore; the caller must stop
  | "acknowledged" // a valid destination acknowledgment flipped a handoff to acknowledged
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

/** A destination's own "Acknowledged by <function>" reply. Silent: it only changes the marker, so it cannot start a loop. */
async function handleAck(event: IntakeEvent, by: Recipient, cfg: IntakeConfig, deps: IntakeDeps): Promise<IntakeOutcome> {
  const base = { evt: "intake", channel: event.channel, ts: event.ts, ack_by: by };
  const skip = (reason: string): IntakeOutcome => {
    deps.log({ ...base, decision: "ack-skip", reason });
    return "skipped";
  };
  if (!event.thread_ts || event.thread_ts === event.ts) return skip("ack-not-in-thread");
  if (await deps.isSelf(event)) return skip("own-post");
  if (!event.user || !cfg.allowedUsers.has(event.user)) return skip("sender-not-allowlisted");
  if (!deps.firstSighting(`ack:${event.channel}:${event.ts}`)) return skip("duplicate-message");

  try {
    const raw = await deps.threadHistory(event.thread_ts);
    const history: HistoryMessage[] = await Promise.all(
      raw.map(async (m) => ({
        ...m,
        self: await deps.isSelf({ type: "message", channel: event.channel, ts: m.ts, user: m.user, bot_id: m.bot_id, text: m.text }),
      }))
    );
    const target = findAckTarget(history, event.ts, by, cfg.allowedUsers);
    if (target.kind === "none") return skip(target.reason);
    await deps.markAcknowledged(target.ts);
    deps.log({ ...base, decision: "acknowledged", handoff_ts: target.ts });
    return "acknowledged";
  } catch (error) {
    deps.log({ ...base, decision: "ack-skip", reason: "marker-error", detail: error instanceof Error ? error.message : String(error) });
    return "skipped";
  }
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

  const ack = parseAck(text);
  if (ack) return handleAck(event, ack, cfg, deps);

  if (isRelayLine(text)) {
    // First line only, truncated: shows why an "Acknowledged by ..." line was not recognized.
    const shown = /^acknowledged by/i.test(firstLine(text)) ? { first_line: firstLine(text).slice(0, 80) } : {};
    deps.log({ ...base, decision: "skip", reason: "relay-line", ...shown });
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
      // GPT's own reply is its acknowledgment.
      await deps.markAcknowledged(event.ts).catch((error) =>
        deps.log({ ...base, step: "markAcknowledged", outcome: "marker-error", detail: error instanceof Error ? error.message : String(error) })
      );
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
    await deps.markPending(event.ts).catch((error) =>
      deps.log({ ...base, step: "markPending", outcome: "marker-error", detail: error instanceof Error ? error.message : String(error) })
    );
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

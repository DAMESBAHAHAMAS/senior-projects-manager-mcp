/**
 * Chat-neutral router: one inbound chat message in, one agent answer out in
 * the same conversation thread.
 *
 *   chat adapter (Slack today, Cliq/Connect later)
 *     -> handleInbound()          route lookup, receipt, agent call
 *     -> triggerZiaAgent()        existing gateway client (zohoZiaClient.ts)
 *     -> ReplyPort.reply()        adapter posts the answer in the same thread
 *
 * The router knows nothing about Slack. An adapter supplies a ReplyPort and a
 * numeric session key that is stable for the thread, so every reply in one
 * thread continues the same Zia conversation.
 *
 * A message that starts with `!gpt` skips Zia entirely: the rest of the text goes
 * to OpenAI (openaiClient.ts) and the answer is posted in the same thread.
 *
 * Failure rule: the person in the channel never sees a technical error. They
 * get one neutral line; the detail goes to the host log and, when the adapter
 * provides it, to the ops alert channel.
 */

import { ZIA_AGENTS } from "../agents.js";
import { triggerZiaAgent } from "../zohoZiaClient.js";
import { askOpenAI } from "../openaiClient.js";
import { ChatSource, findRoute, isRouteActive } from "./routes.js";

export interface InboundMessage {
  source: ChatSource;
  /** Channel / conversation id on the chat platform. */
  conversationId: string;
  /** Digits only; stable for the whole thread (becomes the Zia session id). */
  sessionKey: string;
  /** The person's message text, as typed. */
  text: string;
  /** Opaque reference for logs (never the message text). */
  messageRef: string;
}

export interface ReplyPort {
  /** Show the person their message was received (e.g. an "eyes" reaction). */
  received(): Promise<void>;
  /** Post text into the same thread under the given sender name. */
  reply(text: string, senderName: string): Promise<void>;
  /** Mark the request finished (e.g. swap the receipt reaction for a check or a warning). */
  finished(ok: boolean): Promise<void>;
  /** Optional: send failure detail to the operators' channel. Never shown to the requester. */
  alertOps?(detail: string): Promise<void>;
}

/** Calls an agent and returns its reply text (undefined when the agent returned none). */
export type AgentInvoker = (message: string, agentKey: string, sessionId: string) => Promise<string | undefined>;

export type RouteOutcome = "answered" | "failed" | "not-connected" | "not-routed";

const defaultInvoker: AgentInvoker = async (message, agentKey, sessionId) => {
  const result = await triggerZiaAgent(message, agentKey, sessionId);
  const text = result?.data?.response;
  return typeof text === "string" && text.trim() ? text : undefined;
};

export function neutralFailureText(label: string): string {
  return `${label} could not finish this request. Systems and Automation has the details. Reply in this thread to try again.`;
}

export function notConnectedText(label: string): string {
  return `The ${label} agent is not connected yet. Systems and Automation is building it. Nothing was run.`;
}

/** Never let a chat-platform hiccup (a failed reaction, say) take down the request. */
async function safely(step: string, action: () => Promise<void>, messageRef: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(
      JSON.stringify({ evt: "router", ref: messageRef, step, outcome: "port-error", detail: describe(error) })
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sends a prompt straight to OpenAI and returns the answer text. */
export type GptInvoker = (prompt: string) => Promise<string>;

const GPT_SENDER_NAME = "GPT";
const GPT_PREFIX = /^!gpt(?:\s+([\s\S]*))?$/i;

/** The prompt after a leading `!gpt`, "" for a bare `!gpt`, or null when the message is not a !gpt command. */
export function parseGptCommand(text: string): string | null {
  const match = GPT_PREFIX.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
}

export function gptFailureText(): string {
  return "GPT could not finish this request. Systems and Automation has the details. Send it again starting with !gpt to retry.";
}

export function gptUsageText(): string {
  return "Add a question after !gpt, for example: !gpt Summarize today's Business Operations priorities.";
}

/** `!gpt` path: OpenAI only. Never touches Zia and never falls back to it. */
async function handleGpt(prompt: string, message: InboundMessage, port: ReplyPort, askGpt: GptInvoker): Promise<RouteOutcome> {
  if (!prompt) {
    await safely("reply", () => port.reply(gptUsageText(), GPT_SENDER_NAME), message.messageRef);
    return "answered";
  }

  await safely("received", () => port.received(), message.messageRef);
  const startedAt = Date.now();
  try {
    const answer = await askGpt(prompt);
    if (!answer || !answer.trim()) {
      throw new Error("OpenAI returned no response text");
    }
    await port.reply(answer, GPT_SENDER_NAME);
    await safely("finished", () => port.finished(true), message.messageRef);
    console.error(
      JSON.stringify({ evt: "router", ref: message.messageRef, agent: "openai", outcome: "answered", ms: Date.now() - startedAt, chars: answer.length })
    );
    return "answered";
  } catch (error) {
    const detail = describe(error);
    console.error(
      JSON.stringify({ evt: "router", ref: message.messageRef, agent: "openai", outcome: "failed", ms: Date.now() - startedAt, detail })
    );
    await safely("reply", () => port.reply(gptFailureText(), GPT_SENDER_NAME), message.messageRef);
    await safely("finished", () => port.finished(false), message.messageRef);
    if (port.alertOps) {
      const alert = port.alertOps;
      await safely(
        "alertOps",
        () => alert(`Channel routing failure. Route: OpenAI (!gpt). Ref: ${message.messageRef}. Detail: ${detail.slice(0, 600)}`),
        message.messageRef
      );
    }
    return "failed";
  }
}

export async function handleInbound(
  message: InboundMessage,
  port: ReplyPort,
  invoke: AgentInvoker = defaultInvoker,
  askGpt: GptInvoker = askOpenAI
): Promise<RouteOutcome> {
  const route = findRoute(message.source, message.conversationId);
  if (!route) {
    return "not-routed";
  }

  const gptPrompt = parseGptCommand(message.text);
  if (gptPrompt !== null) {
    return handleGpt(gptPrompt, message, port, askGpt);
  }

  if (!isRouteActive(route)) {
    console.error(
      JSON.stringify({ evt: "router", ref: message.messageRef, agent: route.agentKey, outcome: "not-connected" })
    );
    await safely("reply", () => port.reply(notConnectedText(route.label), route.label), message.messageRef);
    return "not-connected";
  }

  const agent = ZIA_AGENTS[route.agentKey];
  await safely("received", () => port.received(), message.messageRef);

  const startedAt = Date.now();
  try {
    const answer = await invoke(message.text, route.agentKey, message.sessionKey);
    if (!answer) {
      throw new Error("agent returned no response text");
    }
    await port.reply(answer, agent.displayName);
    await safely("finished", () => port.finished(true), message.messageRef);
    console.error(
      JSON.stringify({
        evt: "router",
        ref: message.messageRef,
        agent: route.agentKey,
        outcome: "answered",
        ms: Date.now() - startedAt,
        chars: answer.length,
      })
    );
    return "answered";
  } catch (error) {
    const detail = describe(error);
    console.error(
      JSON.stringify({
        evt: "router",
        ref: message.messageRef,
        agent: route.agentKey,
        outcome: "failed",
        ms: Date.now() - startedAt,
        detail,
      })
    );
    await safely("reply", () => port.reply(neutralFailureText(route.label), agent.displayName), message.messageRef);
    await safely("finished", () => port.finished(false), message.messageRef);
    if (port.alertOps) {
      const alert = port.alertOps;
      await safely(
        "alertOps",
        () => alert(`Channel routing failure. Function: ${route.label}. Agent: ${agent.displayName}. Ref: ${message.messageRef}. Detail: ${detail.slice(0, 600)}`),
        message.messageRef
      );
    }
    return "failed";
  }
}

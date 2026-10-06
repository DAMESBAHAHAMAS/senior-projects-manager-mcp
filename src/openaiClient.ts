/**
 * Direct OpenAI client for the Slack `!gpt` route (see channels/router.ts).
 *
 * Plain HTTPS to the Responses API through axios, which the service already
 * uses, so this adds no dependency. Conversational only: no tools, no Zoho
 * access, no thread memory.
 *
 * Environment (Render): OPENAI_API_KEY (required), OPENAI_MODEL (optional).
 */

import axios from "axios";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 90_000;

const SYSTEM_INSTRUCTIONS =
  "You are a concise business assistant answering inside a Slack thread for DK Operations. " +
  "Answer directly. You have no access to Zoho or any company system in this conversation, " +
  "so say so plainly if asked for live company data instead of guessing.";

interface ResponsesBody {
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  output_text?: string;
}

/** Pull the answer text out of a Responses API body. Undefined when there is none. */
export function extractOutputText(body: ResponsesBody | undefined): string | undefined {
  if (typeof body?.output_text === "string" && body.output_text.trim()) return body.output_text.trim();
  const parts: string[] = [];
  for (const item of body?.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  const text = parts.join("").trim();
  return text || undefined;
}

/** Send one prompt to OpenAI and return the answer. Throws on any failure; the caller reports it. */
export async function askOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;

  try {
    const response = await axios.post<ResponsesBody>(
      OPENAI_RESPONSES_URL,
      { model, instructions: SYSTEM_INSTRUCTIONS, input: prompt, store: false },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
    const text = extractOutputText(response.data);
    if (!text) throw new Error("OpenAI returned no response text");
    return text;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const detail = JSON.stringify(error.response?.data ?? error.message).slice(0, 500);
      throw new Error(`OpenAI request failed (HTTP ${error.response?.status ?? "no response"}): ${detail}`);
    }
    throw error;
  }
}

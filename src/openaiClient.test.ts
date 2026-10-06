import { test } from "node:test";
import assert from "node:assert/strict";

const { extractOutputText, askOpenAI } = await import("./openaiClient.js");

test("extractOutputText reads the Responses API message content", () => {
  const body = { output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: " Hello " }, { type: "output_text", text: "there." }] }] };
  assert.equal(extractOutputText(body), "Hello there.");
  assert.equal(extractOutputText({ output_text: "Direct." }), "Direct.");
  assert.equal(extractOutputText({ output: [] }), undefined);
  assert.equal(extractOutputText(undefined), undefined);
});

test("askOpenAI refuses to run without OPENAI_API_KEY", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(() => askOpenAI("hi"), /OPENAI_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

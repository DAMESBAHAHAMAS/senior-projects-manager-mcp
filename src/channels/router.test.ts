import { test } from "node:test";
import assert from "node:assert/strict";

// The agent registry reads env at import time, so set it before importing.
process.env.ZIA_FINANCE_AGENT_ID = "20971000000099999";
process.env.ZOHO_CLIENT_ID = "test";
process.env.ZOHO_CLIENT_SECRET = "test";
process.env.ZOHO_REFRESH_TOKEN = "test";

const { handleInbound, neutralFailureText, notConnectedText, parseGptCommand, gptFailureText, gptUsageText } = await import("./router.js");
type ReplyPort = import("./router.js").ReplyPort;

function recordingPort() {
  const calls: { step: string; args: unknown[] }[] = [];
  const port: ReplyPort = {
    received: async () => void calls.push({ step: "received", args: [] }),
    reply: async (text, sender) => void calls.push({ step: "reply", args: [text, sender] }),
    finished: async (ok) => void calls.push({ step: "finished", args: [ok] }),
    alertOps: async (detail) => void calls.push({ step: "alertOps", args: [detail] }),
  };
  return { port, calls };
}

const base = { source: "slack" as const, sessionKey: "1791179540154649", text: "What is our cash position?", messageRef: "test" };

test("Business Operations channel reaches the Senior Projects Manager and replies in thread", async () => {
  const { port, calls } = recordingPort();
  let invoked: unknown[] = [];
  const outcome = await handleInbound({ ...base, conversationId: "C0C60NJRTQQ" }, port, async (...args) => {
    invoked = args;
    return "Three tasks are due today.";
  });
  assert.equal(outcome, "answered");
  assert.deepEqual(invoked, ["What is our cash position?", "senior-projects-manager", "1791179540154649"]);
  assert.deepEqual(calls.map((c) => c.step), ["received", "reply", "finished"]);
  assert.deepEqual(calls[1].args, ["Three tasks are due today.", "Senior Projects Manager"]);
  assert.deepEqual(calls[2].args, [true]);
});

test("Finance channel routes to the Finance Agent once its id is set", async () => {
  const { port, calls } = recordingPort();
  const outcome = await handleInbound({ ...base, conversationId: "C0C54DTSNUW" }, port, async (_m, agentKey) => {
    assert.equal(agentKey, "finance");
    return "Latest BofA transaction: 4 Oct.";
  });
  assert.equal(outcome, "answered");
  assert.deepEqual(calls[1].args, ["Latest BofA transaction: 4 Oct.", "Finance Agent"]);
});

test("A failure gives the channel one neutral line and sends the detail to ops only", async () => {
  const { port, calls } = recordingPort();
  const outcome = await handleInbound({ ...base, conversationId: "C0C54DTSNUW" }, port, async () => {
    throw new Error('HTTP 500: {"code":"LLM_INFERENCE_FAILED"}');
  });
  assert.equal(outcome, "failed");
  const reply = calls.find((c) => c.step === "reply")!;
  assert.equal(reply.args[0], neutralFailureText("Finance"));
  assert.ok(!String(reply.args[0]).includes("LLM_INFERENCE_FAILED"));
  assert.deepEqual(calls.find((c) => c.step === "finished")!.args, [false]);
  assert.ok(String(calls.find((c) => c.step === "alertOps")!.args[0]).includes("LLM_INFERENCE_FAILED"));
});

test("An empty agent answer is treated as a failure, not posted", async () => {
  const { port, calls } = recordingPort();
  const outcome = await handleInbound({ ...base, conversationId: "C0C60NJRTQQ" }, port, async () => undefined);
  assert.equal(outcome, "failed");
  assert.equal(calls.find((c) => c.step === "reply")!.args[0], neutralFailureText("Business Operations"));
});

test("A channel whose agent is not deployed says so and runs nothing", async () => {
  const { port, calls } = recordingPort();
  let invoked = false;
  const outcome = await handleInbound({ ...base, conversationId: "C0C54E4PQQ6" }, port, async () => {
    invoked = true;
    return "should not happen";
  });
  assert.equal(outcome, "not-connected");
  assert.equal(invoked, false);
  assert.deepEqual(calls.map((c) => c.step), ["reply"]);
  assert.equal(calls[0].args[0], notConnectedText("Sales and Marketing"));
});

test("An unrouted channel is ignored", async () => {
  const { port, calls } = recordingPort();
  const outcome = await handleInbound({ ...base, conversationId: "C0C20DW4UP5" }, port, async () => "x");
  assert.equal(outcome, "not-routed");
  assert.equal(calls.length, 0);
});

test("A failed receipt reaction does not stop the answer", async () => {
  const { port, calls } = recordingPort();
  port.received = async () => {
    throw new Error("missing_scope");
  };
  const outcome = await handleInbound({ ...base, conversationId: "C0C60NJRTQQ" }, port, async () => "ok");
  assert.equal(outcome, "answered");
  assert.ok(calls.some((c) => c.step === "reply"));
});

test("Only channels with a registered agent are joined", async () => {
  const { activeConversationIds } = await import("./routes.js");
  const ids = activeConversationIds("slack");
  assert.ok(ids.includes("C0C60NJRTQQ"), "business ops joins");
  assert.ok(ids.includes("C0C54DTSNUW"), "finance joins once its id is set");
  assert.ok(!ids.includes("C0C54E4PQQ6"), "sales and marketing stays out until its agent exists");
});

test("!gpt routes to OpenAI with the prefix stripped and never calls Zia", async () => {
  const { port, calls } = recordingPort();
  let ziaCalled = false;
  let prompt: string | undefined;
  const outcome = await handleInbound(
    { ...base, conversationId: "C0C60NJRTQQ", text: "!gpt hello" },
    port,
    async () => {
      ziaCalled = true;
      return "zia";
    },
    async (p) => {
      prompt = p;
      return "Hi from OpenAI.";
    }
  );
  assert.equal(outcome, "answered");
  assert.equal(ziaCalled, false);
  assert.equal(prompt, "hello");
  assert.deepEqual(calls.map((c) => c.step), ["received", "reply", "finished"]);
  assert.deepEqual(calls[1].args, ["Hi from OpenAI.", "GPT"]);
  assert.deepEqual(calls[2].args, [true]);
});

test("!gpt prefix parsing is exact", () => {
  assert.equal(parseGptCommand("!gpt hello"), "hello");
  assert.equal(parseGptCommand("  !GPT   Summarize today.\nSecond line "), "Summarize today.\nSecond line");
  assert.equal(parseGptCommand("!gpt"), "");
  assert.equal(parseGptCommand("!gptx hello"), null);
  assert.equal(parseGptCommand("What is due today? !gpt"), null);
  assert.equal(parseGptCommand("What is due today in Zoho Projects?"), null);
});

test("plain messages still go to Zia and never to OpenAI", async () => {
  const { port } = recordingPort();
  let gptCalled = false;
  let invoked: unknown[] = [];
  const outcome = await handleInbound(
    { ...base, conversationId: "C0C60NJRTQQ", text: "What is due today in Zoho Projects?" },
    port,
    async (...args) => {
      invoked = args;
      return "Three tasks.";
    },
    async () => {
      gptCalled = true;
      return "gpt";
    }
  );
  assert.equal(outcome, "answered");
  assert.equal(gptCalled, false);
  assert.equal(invoked[1], "senior-projects-manager");
});

test("an OpenAI failure gives one neutral line, alerts ops, and does not fall back to Zia", async () => {
  const { port, calls } = recordingPort();
  let ziaCalled = false;
  const outcome = await handleInbound(
    { ...base, conversationId: "C0C60NJRTQQ", text: "!gpt hello" },
    port,
    async () => {
      ziaCalled = true;
      return "zia";
    },
    async () => {
      throw new Error("OpenAI request failed (HTTP 401): invalid_api_key");
    }
  );
  assert.equal(outcome, "failed");
  assert.equal(ziaCalled, false);
  const reply = calls.find((c) => c.step === "reply")!;
  assert.equal(reply.args[0], gptFailureText());
  assert.ok(!String(reply.args[0]).includes("invalid_api_key"));
  assert.deepEqual(calls.find((c) => c.step === "finished")!.args, [false]);
  assert.ok(String(calls.find((c) => c.step === "alertOps")!.args[0]).includes("invalid_api_key"));
});

test("a bare !gpt replies with usage and calls nothing", async () => {
  const { port, calls } = recordingPort();
  let called = false;
  await handleInbound(
    { ...base, conversationId: "C0C60NJRTQQ", text: "!gpt" },
    port,
    async () => {
      called = true;
      return "zia";
    },
    async () => {
      called = true;
      return "gpt";
    }
  );
  assert.equal(called, false);
  assert.equal(calls[0].args[0], gptUsageText());
});

test("!gpt in an unrouted channel is ignored", async () => {
  const { port, calls } = recordingPort();
  const outcome = await handleInbound({ ...base, conversationId: "C0C20DW4UP5", text: "!gpt hi" }, port, async () => "x", async () => "y");
  assert.equal(outcome, "not-routed");
  assert.equal(calls.length, 0);
});

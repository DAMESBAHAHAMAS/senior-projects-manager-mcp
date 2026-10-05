import { test } from "node:test";
import assert from "node:assert/strict";

// The agent registry reads env at import time, so set it before importing.
process.env.ZIA_FINANCE_AGENT_ID = "20971000000099999";
process.env.ZOHO_CLIENT_ID = "test";
process.env.ZOHO_CLIENT_SECRET = "test";
process.env.ZOHO_REFRESH_TOKEN = "test";

const { handleInbound, neutralFailureText, notConnectedText } = await import("./router.js");
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

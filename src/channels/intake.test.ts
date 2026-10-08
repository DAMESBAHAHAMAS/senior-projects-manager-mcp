import { test } from "node:test";
import assert from "node:assert/strict";

const intake = await import("./intake.js");
const haiku = await import("../haikuClient.js");
const { parseHandoff, normalizeRecipient, isRelayLine, readLine, noRequestLine, FAILED_LINE, unrecognizedLine, GPT_FAILED_LINE, handleIntake, RECIPIENTS } = intake;
type IntakeDeps = import("./intake.js").IntakeDeps;
type HaikuResult = import("../haikuClient.js").HaikuResult;

const DAMIAN = "U08FY0GQ9G8";
const cfg = { enabled: true, channels: new Set(["C0C20DW4UP5"]), allowedUsers: new Set([DAMIAN]) };
const handoff = (text: string, extra: object = {}) => ({ type: "message", channel: "C0C20DW4UP5", user: DAMIAN, text, ts: "1.1", ...extra });

function fakeDeps(over: Partial<IntakeDeps> = {}, haikuResult: HaikuResult = { kind: "read", sentence: "Send the March invoice totals." }) {
  const posts: { threadTs: string; text: string }[] = [];
  const calls = { haiku: 0, gpt: 0 };
  const seen = new Set<string>();
  const deps: IntakeDeps = {
    isSelf: async () => false,
    readHandoff: async () => {
      calls.haiku++;
      return haikuResult;
    },
    post: async (threadTs, text) => void posts.push({ threadTs, text }),
    threadMessages: async () => [{ who: "U1", text: "TO: GPT\nWhat is 2+2?" }],
    askGpt: async () => {
      calls.gpt++;
      return "4";
    },
    firstSighting: (k) => (seen.has(k) ? false : (seen.add(k), true)),
    log: () => undefined,
    ...over,
  };
  return { deps, posts, calls };
}

test("recognizer: all six recipients, case and 'and' for '&'", () => {
  for (const r of RECIPIENTS) assert.equal(parseHandoff(`TO: ${r}\nplease do x`)?.recipient, r);
  assert.equal(parseHandoff("to: sales and marketing")?.recipient, "Sales & Marketing");
  assert.equal(parseHandoff("TO: SYSTEMS &amp; AUTOMATION\nFROM: Finance")?.recipient, "Systems & Automation");
  assert.equal(parseHandoff("  TO:   compliance and filings  ")?.recipient, "Compliance & Filings");
});

test("recognizer: ordinary messages and mid-sentence 'to:' are not handoffs", () => {
  assert.equal(parseHandoff("What is due today?"), null);
  assert.equal(parseHandoff("Please send this to: Finance"), null);
  assert.equal(parseHandoff("Hello\nTO: Finance"), null);
  assert.equal(parseHandoff("tomorrow: Finance"), null);
});

test("recognizer: an unrecognized recipient is reported as such", () => {
  const h = parseHandoff("TO: Marketing Interns");
  assert.ok(h);
  assert.equal(h.recipient, null);
  assert.equal(normalizeRecipient("Finance"), "Finance");
});

test("intake lines: exact wording and never 'Acknowledged' or 'Received'", () => {
  const lines = [
    readLine("Finance", "Send the March totals."),
    readLine("Finance", "Confirm Finance received and Acknowledged the invoice."),
    noRequestLine("Finance"),
    FAILED_LINE,
    unrecognizedLine(),
  ];
  assert.equal(
    readLine("Finance", "Send the March totals."),
    "Intake: read and queued for Finance. Not yet acknowledged by that session. Request as read: Send the March totals."
  );
  assert.equal(noRequestLine("Finance"), "Intake: read, but no clear request was found. Sender, please restate what you need from Finance.");
  assert.equal(FAILED_LINE, "Intake failed: DK Operations could not read this post. It has not been queued.");
  assert.ok(unrecognizedLine().startsWith("Intake: recipient not recognized. Use one of:"));
  for (const line of lines) assert.ok(!/Acknowledged|Received/.test(line), line);
  assert.ok(!readLine("Finance", "Ping <!channel> now").includes("<"));
});

test("a read handoff posts the Haiku line in the handoff's own thread", async () => {
  const { deps, posts } = fakeDeps();
  const outcome = await handleIntake(handoff("TO: Finance\nFROM: Systems & Automation\nSend totals"), cfg, deps);
  assert.equal(outcome, "read");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadTs, "1.1");
  assert.ok(posts[0].text.startsWith("Intake: read and queued for Finance."));
});

test("a handoff that is itself a thread reply answers in the parent thread", async () => {
  const { deps, posts } = fakeDeps();
  await handleIntake(handoff("TO: Finance\nx", { ts: "9.9", thread_ts: "5.5" }), cfg, deps);
  assert.equal(posts[0].threadTs, "5.5");
});

test("no clear request and read failure post their own fixed lines", async () => {
  const a = fakeDeps({}, { kind: "no-request" });
  assert.equal(await handleIntake(handoff("TO: Finance\nhi"), cfg, a.deps), "no-request");
  assert.equal(a.posts[0].text, noRequestLine("Finance"));
  const b = fakeDeps({}, { kind: "failed", detail: "HTTP 500" });
  assert.equal(await handleIntake(handoff("TO: Finance\nhi"), cfg, b.deps), "failed");
  assert.equal(b.posts[0].text, FAILED_LINE);
  assert.ok(!b.posts[0].text.includes("500"));
});

test("an unrecognized recipient gets the list and no Haiku call", async () => {
  const { deps, posts, calls } = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Marketing Interns"), cfg, deps), "unrecognized");
  assert.equal(calls.haiku, 0);
  assert.equal(posts[0].text, unrecognizedLine());
});

test("loop guard: relay lines, acknowledgments, own posts and edits produce no reply", async () => {
  for (const text of ["Intake: read and queued for Finance.", "Intake failed: x", "Acknowledged by Finance", "GPT: 4"]) {
    const { deps, posts, calls } = fakeDeps();
    assert.equal(await handleIntake(handoff(text), cfg, deps), "skipped", text);
    assert.equal(posts.length + calls.haiku, 0);
  }
  const own = fakeDeps({ isSelf: async () => true });
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), cfg, own.deps), "skipped");
  assert.equal(own.posts.length, 0);
  const edit = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx", { subtype: "message_changed" }), cfg, edit.deps), "skipped");
  assert.equal(edit.posts.length, 0);
  assert.ok(isRelayLine("acknowledged by systems & automation"));
});

test("replaying the same message produces one intake line", async () => {
  const { deps, posts } = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), cfg, deps), "read");
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), cfg, deps), "skipped");
  assert.equal(posts.length, 1);
});

test("off switch, other channels and ordinary messages fall through to normal routing", async () => {
  const off = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), { ...cfg, enabled: false }, off.deps), "not-intake");
  assert.equal(await handleIntake(handoff("TO: Finance\nx", { channel: "C0C60NJRTQQ" }), cfg, off.deps), "not-intake");
  assert.equal(await handleIntake(handoff("What is due today?"), cfg, off.deps), "not-intake");
  assert.equal(off.posts.length + off.calls.haiku, 0);
});

test("a sender outside the allowlist is ignored", async () => {
  const { deps, posts } = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx", { user: "U0OTHER" }), cfg, deps), "skipped");
  assert.equal(posts.length, 0);
});

test("TO: GPT skips Haiku, answers with thread context, and prefixes GPT:", async () => {
  let prompt = "";
  const { deps, posts, calls } = fakeDeps({
    askGpt: async (p) => {
      prompt = p;
      return "4";
    },
  });
  assert.equal(await handleIntake(handoff("TO: GPT\nWhat is 2+2?"), cfg, deps), "gpt-answered");
  assert.equal(calls.haiku, 0);
  assert.equal(posts[0].text, "GPT: 4");
  assert.ok(prompt.includes("What is 2+2?"));
});

test("a GPT failure posts the fixed failure line and never calls Haiku", async () => {
  const { deps, posts, calls } = fakeDeps({
    askGpt: async () => {
      throw new Error("HTTP 401");
    },
  });
  assert.equal(await handleIntake(handoff("TO: GPT\nhi"), cfg, deps), "gpt-failed");
  assert.equal(posts[0].text, GPT_FAILED_LINE);
  assert.equal(calls.haiku, 0);
});

test("Haiku output interpretation: sentence, NO CLEAR REQUEST, empty", () => {
  assert.deepEqual(haiku.interpretHaikuText("  Send the totals. "), { kind: "read", sentence: "Send the totals." });
  assert.deepEqual(haiku.interpretHaikuText("NO CLEAR REQUEST"), { kind: "no-request" });
  assert.deepEqual(haiku.interpretHaikuText("no clear request."), { kind: "no-request" });
  assert.equal(haiku.interpretHaikuText("").kind, "failed");
  assert.equal(haiku.interpretHaikuText(undefined).kind, "failed");
});

test("readHandoff without a key fails safely instead of inventing a restatement", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await haiku.readHandoff("TO: Finance\nx");
    assert.equal(result.kind, "failed");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";

const intake = await import("./intake.js");
const { parseAck, parseFrom, findAckTarget, parseHandoff, normalizeRecipient, isRelayLine, receiptLine, unrecognizedLine, GPT_FAILED_LINE, handleIntake, RECIPIENTS } = intake;
type IntakeDeps = import("./intake.js").IntakeDeps;

const DAMIAN = "U08FY0GQ9G8";
const cfg = { enabled: true, channels: new Set(["C0C20DW4UP5"]), allowedUsers: new Set([DAMIAN]) };
const handoff = (text: string, extra: object = {}) => ({ type: "message", channel: "C0C20DW4UP5", user: DAMIAN, text, ts: "1.1", ...extra });

function fakeDeps(over: Partial<IntakeDeps> = {}) {
  const posts: { threadTs: string; text: string }[] = [];
  const marks: string[] = [];
  const calls = { gpt: 0 };
  const seen = new Set<string>();
  const deps: IntakeDeps = {
    isSelf: async (e) => e.bot_id === "B0C7K37SWUQ",
    post: async (threadTs, text) => void posts.push({ threadTs, text }),
    threadMessages: async () => [{ who: "U1", text: "TO: GPT\nWhat is 2+2?" }],
    threadHistory: async () => [],
    markPending: async (ts) => void marks.push(`pending:${ts}`),
    markAcknowledged: async (ts) => void marks.push(`acknowledged:${ts}`),
    askGpt: async () => {
      calls.gpt++;
      return "4";
    },
    firstSighting: (k) => (seen.has(k) ? false : (seen.add(k), true)),
    log: () => undefined,
    ...over,
  };
  return { deps, posts, calls, marks };
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

test("a valid handoff gets exactly one receipt, with the exact wording, in its own thread", async () => {
  const { deps, posts, marks } = fakeDeps();
  const outcome = await handleIntake(handoff("TO: Finance\nFROM: Systems & Automation\nSend totals", { ts: "10.1" }), cfg, deps);
  assert.equal(outcome, "received");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadTs, "10.1");
  assert.equal(posts[0].text, "Received and queued for Finance");
  assert.equal(receiptLine("Systems & Automation"), "Received and queued for Systems & Automation");
  assert.deepEqual(marks, ["pending:10.1"]);
});

test("the receipt needs no model call and covers both directions", async () => {
  for (const [to, from] of [["Systems & Automation", "Finance"], ["Finance", "Systems & Automation"]]) {
    const { deps, posts } = fakeDeps();
    assert.equal(await handleIntake(handoff(`TO: ${to}\nFROM: ${from}\nPlease do x`), cfg, deps), "received");
    assert.equal(posts[0].text, `Received and queued for ${to}`);
  }
});

test("a handoff that is itself a thread reply answers in the parent thread", async () => {
  const { deps, posts } = fakeDeps();
  await handleIntake(handoff("TO: Finance\nx", { ts: "9.9", thread_ts: "5.5" }), cfg, deps);
  assert.equal(posts[0].threadTs, "5.5");
});

test("an unrecognized recipient gets the list and no receipt", async () => {
  const { deps, posts } = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Marketing Interns"), cfg, deps), "unrecognized");
  assert.equal(posts[0].text, unrecognizedLine());
});

test("loop guard: relay lines, acknowledgments, own posts and edits produce no reply", async () => {
  for (const text of ["Received and queued for Finance", "Intake: read and queued for Finance.", "Intake failed: x", "Acknowledged by Finance", "GPT: 4"]) {
    const { deps, posts } = fakeDeps();
    assert.equal(await handleIntake(handoff(text), cfg, deps), "skipped", text);
    assert.equal(posts.length, 0);
  }
  const own = fakeDeps({ isSelf: async () => true });
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), cfg, own.deps), "skipped");
  assert.equal(own.posts.length, 0);
  const edit = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx", { subtype: "message_changed" }), cfg, edit.deps), "skipped");
  assert.equal(edit.posts.length, 0);
  assert.ok(isRelayLine("acknowledged by systems & automation"));
  assert.ok(isRelayLine("Received and queued for Finance"));
});

test("replaying the same message produces one intake line", async () => {
  const { deps, posts } = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), cfg, deps), "received");
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), cfg, deps), "skipped");
  assert.equal(posts.length, 1);
});

test("off switch, other channels and ordinary messages fall through to normal routing", async () => {
  const off = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), { ...cfg, enabled: false }, off.deps), "not-intake");
  assert.equal(await handleIntake(handoff("TO: Finance\nx", { channel: "C0C60NJRTQQ" }), cfg, off.deps), "not-intake");
  assert.equal(await handleIntake(handoff("What is due today?"), cfg, off.deps), "not-intake");
  assert.equal(off.posts.length, 0);
});

test("a sender outside the allowlist is ignored", async () => {
  const { deps, posts } = fakeDeps();
  assert.equal(await handleIntake(handoff("TO: Finance\nx", { user: "U0OTHER" }), cfg, deps), "skipped");
  assert.equal(posts.length, 0);
});

test("TO: GPT skips the receipt, answers with thread context, and prefixes GPT:", async () => {
  let prompt = "";
  const { deps, posts } = fakeDeps({
    askGpt: async (p) => {
      prompt = p;
      return "4";
    },
  });
  assert.equal(await handleIntake(handoff("TO: GPT\nWhat is 2+2?"), cfg, deps), "gpt-answered");
  assert.equal(posts[0].text, "GPT: 4");
  assert.ok(prompt.includes("What is 2+2?"));
});

test("a GPT failure posts the fixed failure line", async () => {
  const { deps, posts } = fakeDeps({
    askGpt: async () => {
      throw new Error("HTTP 401");
    },
  });
  assert.equal(await handleIntake(handoff("TO: GPT\nhi"), cfg, deps), "gpt-failed");
  assert.equal(posts[0].text, GPT_FAILED_LINE);
});

// ---------------------------------------------------------------------------
// Status markers and acknowledgments (all simulated: fakes stand in for Slack and for the function sessions)
// ---------------------------------------------------------------------------

const BOT = "B0C7K37SWUQ";
const hist = (ts: string, text: string, extra: object = {}) => ({ ts, text, user: DAMIAN, self: false, ...extra });
const intakeLine = (ts: string, to: string) => hist(ts, `Received and queued for ${to}`, { user: undefined, bot_id: BOT, self: true });
const allowed = new Set([DAMIAN]);

test("the intake bot's own line is never an acknowledgment", async () => {
  const f = fakeDeps({ isSelf: async () => true, threadHistory: async () => [] });
  const line = "Acknowledged by Finance";
  assert.equal(await handleIntake({ ...handoff(line, { ts: "10.9", thread_ts: "10.1" }) }, cfg, f.deps), "skipped");
  assert.deepEqual(f.marks, []);
  assert.equal(parseAck("Received and queued for Finance"), null);
});

test("parsing: acknowledgments name a known function; GPT and prose do not count", () => {
  assert.equal(parseAck("Acknowledged by Finance"), "Finance");
  assert.equal(parseAck("acknowledged by systems and automation."), "Systems & Automation");
  assert.equal(parseAck("Acknowledged by Systems &amp; Automation\nWill start now"), "Systems & Automation");
  assert.equal(parseAck("Acknowledged by Finance *Sent using* <@U0AMNQ8V3J8>"), "Finance");
  assert.equal(parseAck("Acknowledged by Systems & Automation _Sent using_ <@U0AMNQ8V3J8|Claude>"), "Systems & Automation");
  assert.equal(parseAck("Acknowledged by GPT"), null);
  assert.equal(parseAck("Acknowledged by Bob"), null);
  assert.equal(parseAck("I have Acknowledged by Finance"), null);
  assert.equal(parseFrom("TO: Finance\nFROM: Systems & Automation\nx"), "Systems & Automation");
  assert.equal(parseFrom("TO: Finance\nx"), null);
});

test("direction 1: a Finance acknowledgment flips the handoff to Finance from pending to acknowledged", async () => {
  const history = [
    hist("10.1", "TO: Finance\nFROM: Systems & Automation\nSend totals"),
    intakeLine("10.2", "Finance"),
  ];
  const f = fakeDeps({ threadHistory: async () => history });
  const out = await handleIntake(handoff("Acknowledged by Finance", { ts: "10.5", thread_ts: "10.1" }), cfg, f.deps);
  assert.equal(out, "acknowledged");
  assert.deepEqual(f.marks, ["acknowledged:10.1"]);
  assert.equal(f.posts.length, 0, "the relay stays silent on an acknowledgment");
});

test("direction 2: a Systems & Automation acknowledgment flips a handoff from Finance", async () => {
  const history = [
    hist("20.1", "TO: Systems & Automation\nFROM: Finance\nFix the feed"),
    intakeLine("20.2", "Systems & Automation"),
  ];
  const f = fakeDeps({ threadHistory: async () => history });
  assert.equal(await handleIntake(handoff("Acknowledged by Systems & Automation", { ts: "20.5", thread_ts: "20.1" }), cfg, f.deps), "acknowledged");
  assert.deepEqual(f.marks, ["acknowledged:20.1"]);
});

test("false acknowledgments are refused", () => {
  const queued = [hist("1.1", "TO: Finance\nFROM: Systems & Automation\nx"), intakeLine("1.2", "Finance")];
  // wrong function
  assert.equal(findAckTarget(queued, "1.5", "Sales & Marketing", allowed).kind, "none");
  // the sender's own function cannot acknowledge for the recipient
  const self = [hist("1.1", "TO: Finance\nFROM: Finance\nx"), intakeLine("1.2", "Finance")];
  assert.deepEqual(findAckTarget(self, "1.5", "Finance", allowed), { kind: "none", reason: "ack-by-sender-function" });
  // not queued by DK Operations yet
  assert.deepEqual(findAckTarget([hist("1.1", "TO: Finance\nx")], "1.5", "Finance", allowed), { kind: "none", reason: "handoff-not-queued" });
  // a human-typed lookalike of the intake line does not count as queued
  const forged = [hist("1.1", "TO: Finance\nx"), hist("1.2", "Received and queued for Finance", { user: DAMIAN, self: false })];
  assert.equal(findAckTarget(forged, "1.5", "Finance", allowed).kind, "none");
  // an acknowledgment that arrives before the handoff
  assert.equal(findAckTarget(queued, "0.9", "Finance", allowed).kind, "none");
  // a thread with no handoff at all
  assert.equal(findAckTarget([hist("1.1", "hello")], "1.5", "Finance", allowed).kind, "none");
});

test("unsafe acknowledgments through the full path change nothing", async () => {
  const history = [hist("10.1", "TO: Finance\nFROM: Systems & Automation\nx"), intakeLine("10.2", "Finance")];
  const run = async (event: object, over: Partial<IntakeDeps> = {}) => {
    const f = fakeDeps({ threadHistory: async () => history, ...over });
    const out = await handleIntake(handoff("Acknowledged by Finance", event), cfg, f.deps);
    return { out, marks: f.marks, posts: f.posts };
  };
  assert.deepEqual((await run({ ts: "10.5" })).marks, [], "not in a thread");
  assert.deepEqual((await run({ ts: "10.5", thread_ts: "10.5" })).marks, [], "thread root, not a reply");
  assert.deepEqual((await run({ ts: "10.5", thread_ts: "10.1", user: "U0OTHER" })).marks, [], "sender not allowlisted");
  assert.deepEqual((await run({ ts: "10.5", thread_ts: "10.1", user: undefined })).marks, [], "no human sender");
  assert.deepEqual((await run({ ts: "10.5", thread_ts: "10.1" }, { isSelf: async () => true })).marks, [], "own post");
  assert.deepEqual((await run({ ts: "10.5", thread_ts: "10.1", subtype: "message_changed" })).marks, [], "edited message");
});

test("a duplicate acknowledgment does not change anything twice, and the same event is processed once", async () => {
  const history = [
    hist("10.1", "TO: Finance\nFROM: Systems & Automation\nx"),
    intakeLine("10.2", "Finance"),
    hist("10.4", "Acknowledged by Finance"),
  ];
  const f = fakeDeps({ threadHistory: async () => history });
  assert.deepEqual(findAckTarget(history, "10.6", "Finance", allowed), { kind: "none", reason: "already-acknowledged" });
  assert.equal(await handleIntake(handoff("Acknowledged by Finance", { ts: "10.6", thread_ts: "10.1" }), cfg, f.deps), "skipped");
  assert.deepEqual(f.marks, []);
  // the same Slack message delivered twice
  const g = fakeDeps({ threadHistory: async () => history.slice(0, 2) });
  assert.equal(await handleIntake(handoff("Acknowledged by Finance", { ts: "10.4", thread_ts: "10.1" }), cfg, g.deps), "acknowledged");
  assert.equal(await handleIntake(handoff("Acknowledged by Finance", { ts: "10.4", thread_ts: "10.1" }), cfg, g.deps), "skipped");
  assert.deepEqual(g.marks, ["acknowledged:10.1"]);
});

test("two handoffs in one thread: an acknowledgment answers the latest queued one, and only once", () => {
  const history = [
    hist("1.1", "TO: Finance\nFROM: Systems & Automation\nfirst"),
    intakeLine("1.2", "Finance"),
    hist("2.1", "TO: Finance\nFROM: Systems & Automation\nsecond"),
    intakeLine("2.2", "Finance"),
  ];
  assert.deepEqual(findAckTarget(history, "3.0", "Finance", allowed), { kind: "target", ts: "2.1" });
});

test("a failure to change the marker never breaks the relay", async () => {
  const f = fakeDeps({
    threadHistory: async () => [hist("10.1", "TO: Finance\nFROM: Systems & Automation\nx"), intakeLine("10.2", "Finance")],
    markAcknowledged: async () => {
      throw new Error("missing_scope");
    },
  });
  assert.equal(await handleIntake(handoff("Acknowledged by Finance", { ts: "10.5", thread_ts: "10.1" }), cfg, f.deps), "skipped");
  const p = fakeDeps({
    markPending: async () => {
      throw new Error("missing_scope");
    },
  });
  assert.equal(await handleIntake(handoff("TO: Finance\nx"), cfg, p.deps), "received");
  assert.equal(p.posts.length, 1);
});

test("GPT's own reply marks its handoff acknowledged", async () => {
  const f = fakeDeps();
  await handleIntake(handoff("TO: GPT\nWhat is 2+2?", { ts: "30.1" }), cfg, f.deps);
  assert.deepEqual(f.marks, ["acknowledged:30.1"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.ZOHO_CLIENT_ID = "test";
process.env.ZOHO_CLIENT_SECRET = "test";
process.env.ZOHO_REFRESH_TOKEN = "test";

const { verifySlackSignature, sessionKeyFromTs, humanSkipReason, chunkText, toMrkdwn, TtlSet, slackEventsRouter } =
  await import("./slack.js");

const DAMIAN = "U08FY0GQ9G8";
const allowed = new Set([DAMIAN]);
const sign = (secret: string, ts: string, body: string) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

test("signature: valid, tampered, stale", () => {
  const now = 1791179540;
  const body = '{"type":"event_callback"}';
  const sig = sign("s3cret", String(now), body);
  assert.equal(verifySlackSignature("s3cret", String(now), body, sig, now), true);
  assert.equal(verifySlackSignature("s3cret", String(now), body + " ", sig, now), false);
  assert.equal(verifySlackSignature("wrong", String(now), body, sig, now), false);
  assert.equal(verifySlackSignature("s3cret", String(now - 301), body, sign("s3cret", String(now - 301), body), now), false);
  assert.equal(verifySlackSignature("s3cret", undefined, body, sig, now), false);
});

test("session key: Slack ts becomes a 16-digit numeric Zia session id", () => {
  assert.equal(sessionKeyFromTs("1791179540.154649"), "1791179540154649");
  assert.throws(() => sessionKeyFromTs("abc.def"));
});

test("only a hand-typed message from an allowlisted person routes", () => {
  const typed = { type: "message", channel: "C1", user: DAMIAN, text: "What is our cash position?", ts: "1.2" };
  assert.equal(humanSkipReason(typed, allowed), null);
  assert.equal(humanSkipReason({ ...typed, subtype: "thread_broadcast" }, allowed), null);
  assert.equal(humanSkipReason({ ...typed, bot_id: "B1" }, allowed), "bot-post");
  assert.equal(humanSkipReason({ ...typed, app_id: "A1" }, allowed), "app-post");
  assert.equal(humanSkipReason({ ...typed, user: "U0OTHER" }, allowed), "sender-not-allowlisted");
  assert.equal(humanSkipReason({ ...typed, subtype: "message_changed" }, allowed), "subtype:message_changed");
  assert.equal(humanSkipReason({ ...typed, subtype: "channel_join" }, allowed), "subtype:channel_join");
  assert.equal(humanSkipReason({ ...typed, text: "   " }, allowed), "empty-text");
  assert.equal(humanSkipReason({ ...typed, text: "`@ChatGPT Hi`" }, allowed), "plain-at-mention");
  assert.equal(humanSkipReason({ ...typed, text: "@gpt what is due?" }, allowed), "plain-at-mention");
  assert.equal(humanSkipReason({ ...typed, text: "Email me @ 5pm about cash" }, allowed), null);
  assert.equal(
    humanSkipReason({ ...typed, text: "Canon change R-0109\n*Sent using* <@U0AL7P2CE4R|ChatGPT>" }, allowed),
    "agent-attribution"
  );
});

test("long answers split on paragraph breaks under the limit", () => {
  const para = "x".repeat(60);
  const text = Array.from({ length: 10 }, () => para).join("\n\n");
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 200));
  assert.equal(chunks.join("\n\n"), text);
  assert.deepEqual(chunkText("short"), ["short"]);
});

test("markdown fallback converts bold, headings and links", () => {
  assert.equal(toMrkdwn("## Cash\n**$4.57** in [BofA](https://bofa.com)"), "*Cash*\n*$4.57* in <https://bofa.com|BofA>");
});

test("duplicate deliveries are recognised", () => {
  const set = new TtlSet(1000);
  assert.equal(set.firstSighting("Ev1", 0), true);
  assert.equal(set.firstSighting("Ev1", 500), false);
  assert.equal(set.firstSighting("Ev1", 1500), true);
});

async function withServer(env: Record<string, string | undefined>, run: (url: string) => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const app = express();
  app.use(slackEventsRouter());
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}/slack/events`);
  } finally {
    server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("route: setup window answers Slack's URL check and refuses events", async () => {
  await withServer({ SLACK_SIGNING_SECRET: undefined, SLACK_BOT_TOKEN: undefined }, async (url) => {
    const check = await fetch(url, { method: "POST", body: JSON.stringify({ type: "url_verification", challenge: "abc123" }) });
    assert.equal(check.status, 200);
    assert.deepEqual(await check.json(), { challenge: "abc123" });
    const event = await fetch(url, { method: "POST", body: JSON.stringify({ type: "event_callback", event_id: "Ev1" }) });
    assert.equal(event.status, 503);
  });
});

test("route: with the secret set, unsigned requests are refused and signed ones acknowledged", async () => {
  await withServer({ SLACK_SIGNING_SECRET: "s3cret", SLACK_BOT_TOKEN: undefined }, async (url) => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev2",
      event: { type: "message", channel: "C0C20DW4UP5", user: DAMIAN, text: "hi", ts: "1791179540.154649" },
    });
    const unsigned = await fetch(url, { method: "POST", body });
    assert.equal(unsigned.status, 401);
    const ts = String(Math.floor(Date.now() / 1000));
    const signed = await fetch(url, {
      method: "POST",
      body,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sign("s3cret", ts, body) },
    });
    assert.equal(signed.status, 200);
    const check = JSON.stringify({ type: "url_verification", challenge: "xyz" });
    const signedCheck = await fetch(url, {
      method: "POST",
      body: check,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sign("s3cret", ts, check) },
    });
    assert.deepEqual(await signedCheck.json(), { challenge: "xyz" });
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { buildMime, extractAddresses, replyDetails } from "../src/compose.js";

const ME = "me@yahoo.com";

test("extractAddresses accepts names and rejects bad addresses", () => {
  assert.deepEqual(extractAddresses(["Sam <Sam@Example.com>", "lee@example.org"]), ["sam@example.com", "lee@example.org"]);
  assert.throws(() => extractAddresses(["not-an-address"]), /Not a valid email address/);
});

test("buildMime keeps Bcc out of the headers", async () => {
  const raw = (await buildMime({ from: ME, to: ["a@example.com"], bcc: ["secret@example.com"], subject: "Hi", text: "Body" })).toString();
  assert.match(raw, /^To: a@example\.com/m);
  assert.doesNotMatch(raw, /secret@example\.com/);
});

const original = [
  "From: Sam <sam@example.com>",
  "To: me@yahoo.com, lee@example.org",
  "Cc: kim@example.net",
  "Subject: Lunch?",
  "Message-ID: <abc@example.com>",
  "References: <older@example.com>",
  "Date: Fri, 27 Nov 2026 12:00:00 +0000",
  "",
  "Want to get lunch?",
].join("\r\n");

test("reply goes to the sender and threads correctly", async () => {
  const r = replyDetails(await simpleParser(original), ME, false, "Want to get lunch?");
  assert.deepEqual(r.to, ["Sam <sam@example.com>"]);
  assert.deepEqual(r.cc, []);
  assert.equal(r.subject, "Re: Lunch?");
  assert.equal(r.inReplyTo, "<abc@example.com>");
  assert.deepEqual(r.references, ["<older@example.com>", "<abc@example.com>"]);
  assert.match(r.quoted, /> Want to get lunch\?/);
});

test("reply-all adds others but never yourself", async () => {
  const r = replyDetails(await simpleParser(original), ME, true, "");
  assert.deepEqual(r.cc.map((a) => a.replace(/.*</, "").replace(">", "")), ["lee@example.org", "kim@example.net"]);
  assert.ok(!r.cc.some((a) => a.includes(ME)));
});

test("reply honours Reply-To and does not double Re:", async () => {
  const withReplyTo = original.replace("Subject: Lunch?", "Subject: Re: Lunch?\r\nReply-To: list@example.com");
  const r = replyDetails(await simpleParser(withReplyTo), ME, false, "");
  assert.deepEqual(r.to, ["list@example.com"]);
  assert.equal(r.subject, "Re: Lunch?");
});

test("a built reply carries In-Reply-To and References headers", async () => {
  const r = replyDetails(await simpleParser(original), ME, false, "");
  const raw = (await buildMime({ from: ME, to: r.to, subject: r.subject, text: "Sure", inReplyTo: r.inReplyTo, references: r.references })).toString();
  assert.match(raw, /^In-Reply-To: <abc@example\.com>/m);
  assert.match(raw, /^References: <older@example\.com> <abc@example\.com>/m);
});

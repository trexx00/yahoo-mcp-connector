import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { bodyText } from "../src/body.js";

// Builds a small multipart/alternative email with a text part and an HTML part.
function email(plain: string, html: string): string {
  return [
    "From: a@example.com", "Subject: test", "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=XX", "",
    "--XX", "Content-Type: text/plain", "", plain,
    "--XX", "Content-Type: text/html", "", html,
    "--XX--", "",
  ].join("\r\n");
}

test("uses HTML when the plain-text part is empty", async () => {
  const parsed = await simpleParser(email("", "<p>Your order shipped</p><p>Tracking 123</p>"));
  assert.equal(parsed.text?.trim(), ""); // the bug: mailparser alone gives "\n"
  const body = bodyText(parsed);
  assert.match(body, /Your order shipped/);
  assert.match(body, /Tracking 123/);
});

test("prefers the plain-text part when it has content", async () => {
  const parsed = await simpleParser(email("Plain version", "<p>HTML version</p>"));
  assert.equal(bodyText(parsed), "Plain version");
});

test("explains when there is no text at all", async () => {
  const parsed = await simpleParser(email("\n", "<img src='banner.png'>"));
  assert.match(bodyText(parsed), /no text content/);
});

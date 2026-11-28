// Checks the HTTPS server's sign-in behaviour without contacting Cognito or
// Yahoo: a fake verifier accepts one known token and rejects everything else.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { createApp } from "../src/app.js";
import type { AuthConfig } from "../src/auth.js";
import type { YahooConfig } from "../src/config.js";
import { MemoryPendingStore } from "../src/pending.js";

const GOOD = "good-token";
let server: Server;
let base: string;

const config: YahooConfig = {
  email: "me@yahoo.com", appPassword: "x", imapHost: "invalid.example", imapPort: 993,
  smtpHost: "invalid.example", smtpPort: 465, maxSendsPerDay: 20, saveSentCopy: true, confirmTtlMinutes: 10,
};

before(async () => {
  const auth: AuthConfig = {
    publicUrl: new URL("http://localhost:3000"),
    region: "us-east-2",
    userPoolId: "us-east-2_Test",
    clientId: "client123",
    cognitoDomain: new URL("https://example.auth.us-east-2.amazoncognito.com"),
  };
  const app = createApp({
    config, auth, store: new MemoryPendingStore(),
    verifier: {
      async verifyAccessToken(token) {
        if (token !== GOOD) throw new InvalidTokenError("bad");
        return { token, clientId: "client123", scopes: ["openid"], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      },
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const rpc = (body: unknown, token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("without a token, /mcp answers 401 and points to the sign-in metadata", async () => {
  const res = await rpc(init);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("a wrong token is rejected", async () => {
  assert.equal((await rpc(init, "forged")).status, 401);
});

test("protected resource metadata names this server and its login server", async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(meta.resource, "http://localhost:3000/mcp");
  assert.deepEqual(meta.authorization_servers, ["http://localhost:3000"]);
});

test("authorization server metadata points at Cognito and advertises PKCE", async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, "http://localhost:3000");
  assert.equal(meta.authorization_endpoint, "https://example.auth.us-east-2.amazoncognito.com/oauth2/authorize");
  assert.equal(meta.token_endpoint, "https://example.auth.us-east-2.amazoncognito.com/oauth2/token");
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
});

test("with a valid token, the MCP server answers and lists all ten tools", async () => {
  const res = await rpc(init, GOOD);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"serverInfo"/);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, GOOD);
  const text = await list.text();
  for (const name of ["list_folders", "search_mail", "read_message", "create_draft", "send_email", "delete_message", "confirm_action", "move_message", "archive_message", "mark_message"]) {
    assert.match(text, new RegExp(`"${name}"`));
  }
});

test("requests for another host name are refused", async () => {
  // fetch() won't let us change the Host header, so use the lower-level http module.
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(`${base}/.well-known/oauth-protected-resource/mcp`);
    request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject).end();
  });
  assert.equal(status, 403);
});

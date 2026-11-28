// The HTTPS version of the server, used by Claude and Duet.
//
// Routes:
//   /.well-known/oauth-protected-resource/mcp  tells Claude which login server to use
//   /.well-known/oauth-authorization-server    describes that login server (Cognito)
//   POST /mcp                                  the MCP endpoint, which needs a valid token
//
// Each request gets its own fresh MCP server ("stateless" mode). That matches
// AWS Lambda, where requests may each run in a separate copy of this code.
import express, { type Express } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { authorizationServerMetadata, type AuthConfig } from "./auth.js";
import type { YahooConfig } from "./config.js";
import type { PendingStore } from "./pending.js";
import { buildServer } from "./server.js";

export interface AppOptions {
  config: YahooConfig;
  auth: AuthConfig;
  store: PendingStore;
  verifier: OAuthTokenVerifier;
}

export function createApp({ config, auth, store, verifier }: AppOptions): Express {
  const mcpUrl = new URL("/mcp", auth.publicUrl);

  // Only answer requests addressed to our own host name (blocks "DNS rebinding" tricks).
  const app = createMcpExpressApp({
    host: auth.publicUrl.hostname,
    allowedHosts: [auth.publicUrl.hostname, "localhost", "127.0.0.1"],
  });

  // Browser-based tools (like the MCP Inspector) need these headers to read our replies.
  // Safe with "*" because sign-in uses a bearer token, not cookies.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: authorizationServerMetadata(auth),
      resourceServerUrl: mcpUrl,
      scopesSupported: ["openid"],
      resourceName: "Yahoo Mail",
    }),
  );

  const requireAuth = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  app.post("/mcp", requireAuth, async (req, res) => {
    const server = buildServer(config, store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  // Stateless mode has no long-lived sessions, so GET and DELETE aren't used.
  const notAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", requireAuth, notAllowed);
  app.delete("/mcp", requireAuth, notAllowed);

  return app;
}

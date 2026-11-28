// Builds an MCP server with every tool registered. Both entry points use it:
// index.ts (local, stdio) and app.ts (HTTPS, for Claude and Duet).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActionTools } from "./actions.js";
import type { YahooConfig } from "./config.js";
import type { PendingStore } from "./pending.js";
import { registerReadOnlyTools } from "./tools.js";

export function buildServer(config: YahooConfig, store: PendingStore): McpServer {
  const server = new McpServer({ name: "yahoo-mail", version: "0.3.0" });
  registerReadOnlyTools(server, config);
  registerActionTools(server, config, store);
  return server;
}

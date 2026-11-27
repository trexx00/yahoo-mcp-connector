// Entry point for LOCAL use. It talks to the MCP client (the Inspector, or
// Claude Desktop) over stdin/stdout. Step 4 adds an HTTPS entry point for AWS.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerActionTools } from "./actions.js";
import { MemoryPendingStore } from "./pending.js";
import { registerReadOnlyTools } from "./tools.js";

const config = loadConfig();

const server = new McpServer({ name: "yahoo-mail", version: "0.2.0" });
registerReadOnlyTools(server, config);
registerActionTools(server, config, new MemoryPendingStore());

await server.connect(new StdioServerTransport());
// stdout is reserved for the MCP protocol, so status goes to stderr.
console.error("yahoo-mail MCP server running (stdio)");

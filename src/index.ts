// Entry point for LOCAL use over stdin/stdout (the Inspector's STDIO mode, or
// Claude Desktop). It has no sign-in, because only programs on your own
// computer can reach it. http.ts is the entry point that needs sign-in.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { MemoryPendingStore } from "./pending.js";
import { buildServer } from "./server.js";

const server = buildServer(loadConfig(), new MemoryPendingStore());
await server.connect(new StdioServerTransport());
// stdout is reserved for the MCP protocol, so status goes to stderr.
console.error("yahoo-mail MCP server running (stdio)");

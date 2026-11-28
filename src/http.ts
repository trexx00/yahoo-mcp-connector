// Runs the HTTPS-style server on your computer for testing (plain http on
// localhost). On AWS, Step 5 runs the same app behind Lambda's HTTPS URL.
import { cognitoVerifier, loadAuthConfig } from "./auth.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MemoryPendingStore } from "./pending.js";

const config = loadConfig();
const auth = loadAuthConfig();
const port = Number(process.env.PORT ?? auth.publicUrl.port ?? 3000) || 3000;

const app = createApp({ config, auth, store: new MemoryPendingStore(), verifier: cognitoVerifier(auth) });
app.listen(port, "127.0.0.1", () => {
  console.error(`yahoo-mail MCP server listening at ${new URL("/mcp", auth.publicUrl).href}`);
});

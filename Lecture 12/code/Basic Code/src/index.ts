import { createApp } from "./app.js";
import { config } from "./config/config.js";

/**
 * Chapter 17 — the process entry point.
 *
 * The only file that binds the app to a port. Everything above it is importable
 * without a side effect, which is what lets the HTTP server and the CLI
 * (`src/cli.ts`) share the exact same services.
 */
const app = createApp();

app.listen(config.port, () => {
  console.log(`[lecture-12-basic-rag] listening on http://localhost:${config.port}`);
  console.log("  GET  /health   GET /filters   GET /eval   GET /ablation");
  console.log("  POST /search   POST /ask");
});








#!/usr/bin/env node
import { config } from "./config/config.js";
import { app } from "./routes/index.js";

/**
 * Chapter 06 §6.2 — the entry point.
 *
 * Everything interesting is somewhere else: the routes are in `routes/`, the
 * loop is in `services/agent.ts`, the rules are in `services/policy.ts`. This
 * file binds a port and says so.
 *
 * That separation is not decoration. It is what lets `npm run demo` reuse the
 * exact same agent with **no HTTP at all**, which matters because a security
 * test that needs a running server is a security test that runs less often.
 */
const server = app.listen(config.port, config.host, () => {
  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  console.error(`[lecture-19-security] listening on http://${config.host}:${config.port}`);
  console.error(`  try: curl -s http://${config.host}:${config.port}/security`);
  console.error(
    `  and: curl -s -X POST http://${config.host}:${config.port}/chat ` +
      `-H 'content-type: application/json' ` +
      `-d '{"user":"alice","message":"I want a refund for my order ORD-101."}'`,
  );
  console.error(`  and: curl -s -X POST http://${config.host}:${config.port}/attack/indirect-no-filter`);
  console.error(`  and: npm run demo`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}

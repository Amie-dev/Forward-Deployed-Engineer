#!/usr/bin/env node
import { config } from "./config/config.js";
import { app } from "./routes/index.js";

/**
 * Chapter 02 §2.4 — the entry point.
 *
 * Everything interesting is somewhere else: the routes are in `routes/`, the agent
 * is in `services/`, and the dataset is in `domain/`. This file binds a port and
 * says so.
 *
 * That separation is not decoration. It is what lets `npm run eval` reuse the exact
 * same services with **no HTTP at all** — which is Chapter 08 §8.5's point: the
 * offline run is the one that gates a release, and it should not need a server.
 */
const server = app.listen(config.port, config.host, () => {
  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  console.error(`[lecture-18-testing] listening on http://${config.host}:${config.port}`);
  console.error(
    `  try: curl -s -X POST http://${config.host}:${config.port}/chat ` +
      `-H 'content-type: application/json' -d '{"message":"Where is ORD-101?"}'`,
  );
  console.error(`  and: curl -s http://${config.host}:${config.port}/eval`);
  console.error(`  and: npm run eval`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}

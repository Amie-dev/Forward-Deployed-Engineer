#!/usr/bin/env node
import { config } from "./config/config.js";
import { app } from "./routes/index.js";

/**
 * Chapter 02 — the entry point.
 *
 * Everything interesting is somewhere else: the routes are in `routes/`, the
 * evaluation is in `services/`, and the dataset is in `domain/`. This file binds
 * a port and says so.
 *
 * That separation is not decoration. It is what lets `npm run eval` reuse the
 * exact same services with **no HTTP at all** — which is Chapter 09 §9.1's
 * point: the offline run is the one that gates the release, and it should not
 * need a server to do it.
 */
const server = app.listen(config.port, config.host, () => {
  // Diagnostics go to stderr, so stdout stays free for anything that reads it.
  console.error(`[lecture-17-evals] listening on http://${config.host}:${config.port}`);
  console.error(`  try: curl 'http://${config.host}:${config.port}/eval?topk=3'`);
  console.error(`  and: npm run eval -- --topk=1 --baseline=3`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
  });
}

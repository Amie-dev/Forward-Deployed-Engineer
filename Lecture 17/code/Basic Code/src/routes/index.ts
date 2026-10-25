import express, { type Express, type Request, type Response } from "express";

import { evalController } from "../controllers/evalController.js";
import { createJudge } from "../services/judge.js";
import { createOnlineMonitor } from "../services/online.js";

/**
 * Chapter 02 §2.4 — **the route table.**
 *
 * Eight lines of routing, and no evaluation logic at all. That is the point of
 * the layering: the loop lives in `services/`, and a route is a path plus a
 * method. Chapter 08 §8.5's whole pipeline is reachable from here without any of
 * it being *implemented* here.
 */

// One judge and one online monitor per process. The judge is stateless; the
// monitor is stateful by nature, because it accumulates interactions.
const deps = { judge: createJudge(), online: createOnlineMonitor() };
const controller = evalController(deps);

export const app: Express = express();

// Express advertises itself by default, and a server that answers strangers
// should not volunteer its stack.
app.disable("x-powered-by");

// Needed for the two POST routes. The lecture's own point applies here: a
// structured request is easier to validate than a prose one.
app.use(express.json());

app.get("/", controller.index);
app.get("/ask", controller.ask);
app.get("/dataset", controller.describeDataset);
app.get("/eval", controller.evaluate);
app.get("/pairwise", controller.pairwise);
app.get("/online", controller.online);
app.post("/feedback", controller.feedback);
app.post("/promote", controller.promote);

/**
 * The 404, as a catch-all registered *after* every route — the same shape as
 * Chapter 09's "block the release, but say why" gate: a failure should tell you
 * what to try next.
 */
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});

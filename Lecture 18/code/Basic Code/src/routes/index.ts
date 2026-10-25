import express, { type Express, type Request, type Response } from "express";
import { chatController } from "../controllers/chatController.js";
import { evalController } from "../controllers/evalController.js";
import { requestContext } from "../middleware/requestContext.js";
import { createModel } from "../services/model.js";
import { SupportAgent } from "../services/supportAgent.js";

/**
 * Chapter 02 §2.4 — the route table.
 *
 * Four lines of routing and no evaluation logic at all. That is the layering: the
 * agent lives in `services/supportAgent.ts`, the pipeline in `services/pipeline.ts`,
 * and a route is a path plus a method.
 */

// One agent per process. The model client is chosen here — and nowhere else.
const chat = chatController({ agent: new SupportAgent(createModel()) });
const evals = evalController();

export const app: Express = express();

// Express advertises itself by default, and a server that answers strangers
// should not volunteer its stack.
app.disable("x-powered-by");

app.use(requestContext);

// Needed for POST /chat. Chapter 06 §6.5's point applies to the wire too: a
// structured request is easier to validate than a prose one.
app.use(express.json());

app.get("/", evals.index);
app.post("/chat", chat.chat);
app.get("/dataset", evals.dataset);
app.get("/eval", evals.evaluate);

/**
 * The 404, registered *after* every route — the same shape as the release gate:
 * a failure should tell you what to try next.
 */
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});

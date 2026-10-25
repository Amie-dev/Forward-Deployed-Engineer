import express, { type Express, type Request, type Response } from "express";
import { chatController } from "../controllers/chatController.js";
import { securityController } from "../controllers/securityController.js";
import { requestContext } from "../middleware/requestContext.js";
import { Agent } from "../services/agent.js";
import { createModel } from "../services/model.js";
import { createScenarios } from "../services/scenarios.js";

/**
 * Chapter 06 §6.2 — the route table.
 *
 * Six lines of routing and no security logic at all, which is the layering: the
 * loop lives in `services/agent.ts`, the rules live in `services/policy.ts`, and
 * a route is a path plus a method.
 *
 * The wiring above the routes is where the two decisions Chapter 07 §7.4 and
 * Chapter 02 §2.8 ask to be made in exactly one place are made: which model, and
 * which agent every surface shares.
 */

// One agent per process, so the audit log and the confirmation store are shared
// by the CLI, the HTTP surface and the attack endpoints.
const agent = new Agent(createModel());
const scenarios = createScenarios({ agent });

const chat = chatController({ agent });
const security = securityController({ scenarios });

export const app: Express = express();

// Express advertises itself by default, and a server that answers strangers
// should not volunteer its stack.
app.disable("x-powered-by");

app.use(requestContext);

// Chapter 09 §9.4 — a request size limit, before anything reads the body. The
// input guardrail has a length rule too; this one runs earlier and costs less,
// because a payload that is never parsed is never a payload.
app.use(express.json({ limit: "16kb" }));

app.get("/", security.index);
app.post("/chat", chat.chat);
app.get("/security", security.security);
app.get("/audit", security.audit);
app.get("/scenarios", security.scenarios);
app.post("/attack/:scenario", security.attack);

/**
 * The 404, registered *after* every route — the same shape as a refusal: it
 * says what to try next instead of only saying no.
 */
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});

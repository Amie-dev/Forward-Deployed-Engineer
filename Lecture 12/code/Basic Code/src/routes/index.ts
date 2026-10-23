import { Router } from "express";
import {
  ablationHandler,
  ask,
  evaluateHandler,
  filters,
  health,
  search,
} from "../controllers/ragController.js";

/**
 * Chapter 15 — the route table.
 *
 * A route is a *binding*: it names a path and a method and points at a
 * controller function. There is no logic here, which is the point — the whole
 * HTTP surface of the project fits on one screen.
 *
 * The two POST routes take `{ question: string }`. Note what they do **not**
 * take: a tenant, an ACL or a date. Those come from configuration (Chapter 07),
 * which is what makes Chapter 05's IDOR case impossible over HTTP.
 */
export const routes: Router = Router();

routes.get("/health", health);
routes.get("/filters", filters);
routes.get("/eval", evaluateHandler);
routes.get("/ablation", ablationHandler);
routes.post("/search", search);
routes.post("/ask", ask);


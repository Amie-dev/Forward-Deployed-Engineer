import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import { ResourceError } from "../core/errors.js";
import type { HostDeps } from "../host/deps.js";
import { query } from "../middleware/requestContext.js";

/**
 * Notes Ch03 §3.1 — **two operations, not one.**
 *
 * *"MCP provides separate operations for discovering and reading Resources."*
 * That is a deliberate design choice, and the two routes below mirror it exactly:
 *
 *   `GET /resources`  → `resources/list`  cheap, cacheable, metadata only
 *   `GET /read`       → `resources/read`  deliberate, expensive, and policy-checked
 *
 * Keeping them apart in the HTTP API as well as on the wire is what stops the
 * most common waste in a resource-based application: a host that reads every
 * resource to find out which one it needed. Discovery is metadata; a client that
 * pays for content to answer *"what exists?"* has already lost.
 */
export function resourceController(deps: HostDeps) {
  return {
    /**
     * `resources/list` plus `resources/templates/list`.
     *
     * Both are returned in one response because a client needs both to render an
     * "attach context" picker: the instances it can offer as checkboxes, and the
     * templates it can offer as a text field. The distinction between them is the
     * user-facing half of Chapter 04.
     */
    list: async (request: Request, response: Response): Promise<void> => {
      const { resources, templates } = await deps.client.listResources();

      response.json({
        // The concrete addresses. `description` is included because Notes Ch03
        // §3.6 makes it a *user-facing* field: a checkbox labelled
        // `task://guidelines` is unusable, and one labelled "Task management
        // guidelines" is not.
        resources: resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          title: resource.title,
          description: resource.description,
          mimeType: resource.mimeType,
        })),
        // The families. A template is not readable as-is — it has to be bound —
        // which is exactly why it is reported separately rather than mixed in.
        templates: templates.map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name,
          title: template.title,
          description: template.description,
          mimeType: template.mimeType,
        })),
        count: resources.length + templates.length,
      });
    },

    /**
     * `resources/read` for one URI, gated by the host's ACL.
     *
     * The order here is the security design, and it is worth reading as a
     * sequence: **validate the request shape → authorise the session → read.**
     *
     * Authorisation comes *before* the read, never after. Notes Ch05
     * §"Filter *before* ranking" gives the reason for the ranking path, and it
     * applies here for a stronger one: a check that runs after the read has
     * already leaked whatever it was checking for.
     */
    read: async (request: Request, response: Response): Promise<void> => {
      const uri = query(request, "uri")?.trim();

      if (uri === undefined || uri === "") {
        throw new ResourceError(
          "INVALID_INPUT",
          "Query parameter 'uri' is required.",
          "Call GET /resources first to see the advertised URIs, then pass one as ?uri=task://guidelines.",
        );
      }

      const session = request.session;
      const decision = deps.policy.mayRead(uri, session);

      if (!decision.allowed) {
        deps.metrics.count("resource.denied");
        deps.audit.record({
          actor: session.actor,
          action: "resource",
          target: uri,
          decision: "blocked",
          outcome: "denied",
          args: { uri },
          durationMs: 0,
          note: decision.reason,
        });

        // The decision carries the failure class, so the controller answers 404
        // for an address that does not exist and 403 for one the session may not
        // read — instead of collapsing both into "no".
        throw new ResourceError(
          decision.code,
          `Refused to read ${uri} — ${decision.reason}.`,
          decision.code === "NOT_FOUND"
            ? "Call GET /resources to read the advertised URIs, then retry with one of them."
            : "Read a Resource the session is entitled to, or ask an administrator for access.",
        );
      }

      const startedAt = performance.now();
      const body = await deps.client.read(uri);

      deps.audit.record({
        actor: session.actor,
        action: "resource",
        target: uri,
        decision: "allowed",
        outcome: "ok",
        args: { uri },
        durationMs: performance.now() - startedAt,
        // The accountable facts: how big, what type, and why it was allowed.
        // The *content* is deliberately never recorded.
        note: `${body.chars} chars, ${body.mimeType}, ${decision.reason}`,
      });

      response.json({
        uri: body.uri,
        mimeType: body.mimeType,
        chars: body.chars,
        // The budget is applied to *prompt assembly*, not to an explicit read —
        // a user who asked for this document is entitled to all of it. The
        // controller still reports the size so a caller can see what it cost.
        text: body.text,
        policy: decision.reason,
      });
    },
  };
}

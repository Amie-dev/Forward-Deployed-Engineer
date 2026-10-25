# Chapter 25 — Controllers & Router

> **The host's HTTP surface.** Four controllers, nine routes, and one rule: *the router maps a path to a controller
> method and does nothing else.* Every decision already lives somewhere else — which is why each route in
> `routes/index.ts` is one line.

---

## File details

| | |
| :--- | :--- |
| **Files** | `src/controllers/healthController.ts` (105), `resourceController.ts` (137), `promptController.ts` (183), `planController.ts` (276), `src/routes/index.ts` (194) |
| **Layer** | `controllers` + `routes` — the HTTP binding |
| **Purpose** | Expose the pipeline as nine routes, each controller taking `HostDeps` and returning a `Response`. |
| **Exports** | `healthController()`, `resourceController()`, `promptController()`, `planController()` · *(the router is a program)* |
| **Lecture sections** | Ch08 §8.2 (the end-to-end request), Ch03 §3.1 (discovery is not consumption), Ch06/Ch07 (the prompt surface) |
| **Runs** | `npm run host` |

---

## Commands

```bash
npm run server & npm run host & sleep 4

# the index — what this host offers, for a human who just curled it
curl -s http://127.0.0.1:8080/

# the nine routes, by status code
for u in / /health /metrics /resources '/read?uri=task://summary' /prompts '/prompt?name=plan_day&availableHours=4' '/plan?hours=4' '/ask?message=what%20is%20on%20my%20plate'; do
  printf '%-46s -> %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080$u")"
done
```

---

## The nine routes

| Route | Controller | What it demonstrates |
| :--- | :--- | :--- |
| `GET /` | `health.index` | The index — prose, for a human |
| `GET /health` | `health.health` | **Readiness, proven** by a round trip |
| `GET /metrics` | `health.metrics` | The in-process numbers |
| `GET /resources` | `resources.list` | **Discovery is not consumption** |
| `GET /read?uri=…` | `resources.read` | One Resource, ACL-checked before the read |
| `GET /prompts` | `prompts.list` | The menu, with each argument's shape |
| `GET /prompt?name=…` | `prompts.get` | **No model is called** |
| `GET /plan?hours=4` | `plan.plan` | **The lecture's request** — prompt + context + model |
| `GET /ask?message=…` | `plan.ask` | The same pipeline with the user's own words |

Four controllers, and the grouping is by primitive: health and metrics are about the *host*, resources and prompts are
one primitive each, and `plan`/`ask` are the composition of all three.

---

## `src/controllers/healthController.ts` — the full file

```ts
import type { Request, Response } from "express";
import { env, hasModelKey } from "../config/env.js";
import type { HostDeps } from "../host/deps.js";
import { query } from "../middleware/requestContext.js";

/**
 * Liveness, readiness and the numbers.
 *
 * A health endpoint is where the two halves of this project meet in the most
 * useful way: it is the only place that can answer *"is the server reachable,
 * which capabilities did it advertise, and is a model even configured?"* without
 * a user asking a question.
 *
 * The distinction between the two routes is deliberate:
 *
 *  · `GET /` is the **index** — what this host offers, in prose, for a human who
 *    has just curled it and has no idea what to try.
 *  · `GET /health` is **readiness** — it actually calls `tools/list` against the
 *    server, because a process that is listening but cannot reach its capability
 *    provider is not ready, and a health check that only proves the HTTP server
 *    is up is the kind of check that passes during an outage.
 */

export function healthController(deps: HostDeps) {
  const startedAt = Date.now();

  return {
    /** The index. Cheap, static, and the first thing a human reads. */
    index: (request: Request, response: Response): void =>
      response.json({
        host: "task-host",
        version: env.MCP_SERVER_VERSION,
        server: env.MCP_SERVER_URL,
        model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline (no OPENAI_API_KEY)",
        routes: [
          { method: "GET", path: "/", description: "this index" },
          { method: "GET", path: "/health", description: "readiness, with live capability counts" },
          { method: "GET", path: "/resources", description: "the catalogue: resources and templates" },
          { method: "GET", path: "/read?uri=<uri>", description: "read one Resource (policy-checked)" },
          { method: "GET", path: "/prompts", description: "the prompt menu, with argument shapes" },
          { method: "GET", path: "/prompt?name=<name>&...", description: "render one Prompt (no model call)" },
          { method: "GET", path: "/plan?hours=4", description: "the end-to-end request: prompt + context + model" },
          { method: "GET", path: "/metrics", description: "the in-process counters and latencies" },
        ],
        headers: {
          "x-actor": "the user id this session acts as (default 123)",
          "x-projects": "comma-separated project scope, e.g. fde,media",
          "x-admin": '"true" to allow reading another user\'s profile',
        },
      }),

    /**
     * Readiness, proven rather than asserted.
     *
     * The round trip to `tools/list` is the check. It is the cheapest call that
     * exercises the whole chain — session, transport, handshake, capability
     * negotiation — and if it fails, the honest answer is 503.
     */
    health: async (request: Request, response: Response): Promise<void> => {
      const logger = request.logger;

      try {
        const [resources, prompts, tools] = await Promise.all([
          deps.client.listResources(),
          deps.client.listPrompts(),
          deps.client.listTools(),
        ]);

        response.json({
          status: "ready",
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          server: { url: env.MCP_SERVER_URL, version: env.MCP_SERVER_VERSION },
          model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline",
          capabilities: {
            resources: resources.resources.length,
            resourceTemplates: resources.templates.length,
            prompts: prompts.length,
            tools: tools.length,
          },
          limits: {
            ...deps.limits,
            maxTasks: env.MCP_MAX_TASKS,
            resourceCacheTtlMs: env.MCP_RESOURCE_CACHE_TTL_MS,
            allowedSchemes: env.MCP_ALLOWED_RESOURCE_SCHEMES,
          },
          metrics: deps.metrics.snapshot(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        deps.metrics.count("health.unready");
        logger.error("health.unready", { message });

        response.status(503).json({ status: "unready", reason: message });
      }
    },

    /** The raw counter snapshot — the thing a scrape would read. */
    metrics: (request: Request, response: Response): void =>
      response.json({
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        metrics: deps.metrics.snapshot(),
      }),
  };
}
```

### Block-by-block

**Block 1 — the header, and the two-route distinction (lines 5–19).**

> The distinction between the two routes is deliberate:
>
> · `GET /` is the **index** — what this host offers, in prose, for a human who has just curled it and has no idea what to
>   try.
> · `GET /health` is **readiness** — it actually calls `tools/list` against the server, because a process that is
>   listening but cannot reach its capability provider is not ready, and **a health check that only proves the HTTP server
>   is up is the kind of check that passes during an outage.**

That last clause is the argument, and it is worth being concrete about. The naive health check returns `200 OK` because
the *process* is alive — so an orchestrator keeps routing traffic to a host whose MCP session is dead. Every request then
fails, and the health endpoint reports green throughout.

**Block 2 — the index, and `startedAt` (lines 21–52).**

```ts
export function healthController(deps: HostDeps) {
  const startedAt = Date.now();

  return {
    index: (request: Request, response: Response): void =>
      response.json({
        host: "task-host",
        version: env.MCP_SERVER_VERSION,
        server: env.MCP_SERVER_URL,
        model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline (no OPENAI_API_KEY)",
        routes: [ /* eight entries */ ],
        headers: {
          "x-actor": "the user id this session acts as (default 123)",
          "x-projects": "comma-separated project scope, e.g. fde,media",
          "x-admin": '"true" to allow reading another user\'s profile',
        },
      }),
  };
}
```

**`startedAt` is captured once, at controller construction** — not per request. So `uptimeSeconds` measures how long the
*controller* has existed, which is effectively the process's uptime because `routes/index.ts` builds the controllers once
at boot (Chapter 25's router section). A per-request `startedAt` would report `0` every time.

**The index is deliberately prose.** Eight routes with descriptions, plus the three session headers documented in place —
so a reader who has just curled `GET /` knows what to try next without reading the source. That is the whole point of an
index endpoint, and it is why the descriptions are sentences (*"the end-to-end request: prompt + context + model"*) rather
than field names.

**`model: hasModelKey ? \`openai:${env.OPENAI_MODEL}\` : "offline (no OPENAI_API_KEY)"`** — the host reporting its own
configuration. This is where the `"openai"` string from Chapter 16's grep came from: not an import, a *report*.

**The `headers` block documents the auth substitution in the API itself.** So the fact that this deployment reads identity
from headers is discoverable from the running service, not only from the README. That is the right place for it — a
security-relevant substitution should be visible to whoever is using the thing.

**Block 3 — `health`, readiness proven (lines 54–96).**

```ts
health: async (request: Request, response: Response): Promise<void> => {
  const logger = request.logger;

  try {
    const [resources, prompts, tools] = await Promise.all([
      deps.client.listResources(),
      deps.client.listPrompts(),
      deps.client.listTools(),
    ]);

    response.json({
      status: "ready",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      server: { url: env.MCP_SERVER_URL, version: env.MCP_SERVER_VERSION },
      model: hasModelKey ? `openai:${env.OPENAI_MODEL}` : "offline",
      capabilities: {
        resources: resources.resources.length,
        resourceTemplates: resources.templates.length,
        prompts: prompts.length,
        tools: tools.length,
      },
      limits: { ...deps.limits, maxTasks: env.MCP_MAX_TASKS, resourceCacheTtlMs: env.MCP_RESOURCE_CACHE_TTL_MS, allowedSchemes: env.MCP_ALLOWED_RESOURCE_SCHEMES },
      metrics: deps.metrics.snapshot(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    deps.metrics.count("health.unready");
    logger.error("health.unready", { message });

    response.status(503).json({ status: "unready", reason: message });
  }
}
```

**Three list calls, concurrently, and that is the readiness check.** They exercise the whole chain — session, transport,
handshake, capability negotiation — and they are the *cheapest* calls that do. Note `Promise.all` here, not `allSettled`
(Chapter 21): a readiness check wants the all-or-nothing semantics, because "partially ready" is not a state an
orchestrator can act on.

**The payload reports the negotiated catalogue, not the configured one:** `resources.resources.length`,
`resources.templates.length`, `prompts.length`, `tools.length`. So a `/health` response answers *"what does the server
actually advertise right now?"* — which is the question a readiness check exists to answer, and it is why the numbers
come from the wire rather than from `env`.

**`limits` merges the three budget knobs with two more** (`maxTasks`, `resourceCacheTtlMs`) plus `allowedSchemes` — so the
whole running policy is visible in one response. And `metrics: deps.metrics.snapshot()` embeds the counters, which makes
`/health` a superset of `/metrics` (they share the snapshot call).

**The failure branch is a 503, and the status code is the point.** `status: "unready"` with the error message, and
`deps.metrics.count("health.unready")` plus a `logger.error` — so an unreachable capability provider is visible in three
places: the response, the metric and the log. An orchestrator will take the instance out of rotation, and an operator will
see why.

**Block 4 — `metrics` (lines 98–104).**

```ts
metrics: (request: Request, response: Response): void =>
  response.json({
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    metrics: deps.metrics.snapshot(),
  }),
```

Three lines, and it is the **unauthenticated scrape endpoint** — the one thing a Prometheus or a load balancer reads. Note
it is a plain `snapshot()` with no filtering: this host has no secrets in its metrics, which is why exposing them is safe.
A deployment whose metric names embedded user ids would need to think about that.

---

## `src/controllers/resourceController.ts` — the full file

```ts
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
```

### Block-by-block

**Block 5 — the header: two operations, not one (lines 7–20).**

> *"MCP provides separate operations for discovering and reading Resources."* That is a deliberate design choice, and the
> two routes below mirror it exactly:
>
> ```text
> GET /resources  →  resources/list   cheap, cacheable, metadata only
> GET /read       →  resources/read   deliberate, expensive, and policy-checked
> ```
>
> Keeping them apart in the HTTP API as well as on the wire is what stops the most common waste in a resource-based
> application: **a host that reads every resource to find out which one it needed.** Discovery is metadata; a client that
> pays for content to answer *"what exists?"* has already lost.

That is the HTTP API mirroring the protocol's own split, and the waste it prevents is real. A client that reads six
Resources to decide which one it wants has paid six reads and six renderers' worth of work — and, in a real deployment, six
network round trips — for a question `resources/list` answers from metadata alone.

**Block 6 — `list`, both verbs in one response (lines 22–58).**

```ts
list: async (request: Request, response: Response): Promise<void> => {
  const { resources, templates } = await deps.client.listResources();

  response.json({
    resources: resources.map((resource) => ({ uri, name, title, description, mimeType })),
    templates: templates.map((template) => ({ uriTemplate, name, title, description, mimeType })),
    count: resources.length + templates.length,
  });
}
```

**Both are returned together** — *because a client needs both to render an "attach context" picker: the instances it can
offer as checkboxes, and the templates it can offer as a text field.* That is the user-facing half of Chapter 04, and it is
why `deps.client.listResources()` drains two verbs (Chapter 19).

**The two arrays have different key names for their address**: `uri` for an instance, `uriTemplate` for a template. That is
the protocol's own distinction surfacing in the JSON, and it is *not* cosmetic: a client that treated `uriTemplate` as a
`uri` would try to read `task://projects/{projectId}` — an address that means "any project" and therefore no project.

**The `description` is included, and the comment on `resources` explains why with a concrete comparison:**

> a checkbox labelled `task://guidelines` is unusable, and one labelled "Task management guidelines" is not.

That is Chapter 08's dual-role field paying off: the same string is the ranker's input and the picker's label. A catalogue
written for a machine would be unusable as a UI; one written for a human would rank poorly. This endpoint is where the two
uses are visible at once.

**`count` is the sum**, so a caller can assert that it received everything — a cheap integrity check on a paginated verb.

**Block 7 — `read`, and the order that is the security design (lines 60–136).**

```ts
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
    deps.audit.record({ actor: session.actor, action: "resource", target: uri, decision: "blocked", outcome: "denied", args: { uri }, durationMs: 0, note: decision.reason });

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

  deps.audit.record({ actor: session.actor, action: "resource", target: uri, decision: "allowed", outcome: "ok", args: { uri }, durationMs: performance.now() - startedAt, note: `${body.chars} chars, ${body.mimeType}, ${decision.reason}` });

  response.json({ uri: body.uri, mimeType: body.mimeType, chars: body.chars, text: body.text, policy: decision.reason });
}
```

**The doc comment names the sequence, and it is the whole security design:**

> The order here is the security design, and it is worth reading as a sequence: **validate the request shape → authorise the
> session → read.**
>
> Authorisation comes *before* the read, never after. Notes Ch05 §"Filter *before* ranking" gives the reason for the
> ranking path, and it applies here for a **stronger** one: **a check that runs after the read has already leaked whatever
> it was checking for.**

That strengthening is worth following. In the ranking path, a late check leaks *existence* (a router learns a Resource
exists). Here, a late check would leak *content* — because the read would already have happened, and the body would be in
memory. So the ordering is not just good practice; it is the difference between leaking a URI and leaking a document.

**Four stages, and each has a distinct failure:**

| Stage | Failure | Status |
| :--- | :--- | :--- |
| 1. Shape | `uri` missing or empty | **400** `INVALID_INPUT` |
| 2. Authorise | The ACL refused | **404** or **403** — `decision.code` |
| 3. Read | The read threw | A protocol error, via `errorHandler` |
| 4. Respond | — | 200 with the body |

**Stage 2's throw uses `decision.code` as the class**, and the comment explains the payoff: *the decision carries the
failure class, so the controller answers 404 for an address that does not exist and 403 for one the session may not read —
instead of collapsing both into "no".* That is Chapter 20's `ResourceDecision.code` being consumed exactly as designed.

**The recovery sentence is chosen by class**, which is a nice touch — the two refusals need different instructions:

```ts
decision.code === "NOT_FOUND"
  ? "Call GET /resources to read the advertised URIs, then retry with one of them."
  : "Read a Resource the session is entitled to, or ask an administrator for access.",
```

A caller with a typo is told to list the catalogue; a caller without permission is told to stop trying and ask an admin.
One ternary, and it is the difference between a message a user can act on and one they cannot.

**The refusal is audited *before* the throw**, with `decision: "blocked"` and `outcome: "denied"` — the two vocabulary
values Chapter 22 anticipated. So a denied read is recorded with the *reason*, which is the fact an incident review asks
for.

**The success audit records three accountable facts and no content:**

```ts
note: `${body.chars} chars, ${body.mimeType}, ${decision.reason}`,
```

*The accountable facts: how big, what type, and why it was allowed. The **content** is deliberately never recorded.* That
is Chapter 22's second omission enforced at the call site — a note about the body, never the body.

**And the response includes a `policy` field:**

```ts
response.json({ uri: body.uri, mimeType: body.mimeType, chars: body.chars, text: body.text, policy: decision.reason });
```

So the response says *why it was allowed* — `"project" is public` or `"user-profile" belongs to the session's own user`.
A caller can see the policy that applied without a second request, which is what makes the ACL observable from outside.

**The comment on `text` states the budget boundary:**

> The budget is applied to *prompt assembly*, not to an explicit read — **a user who asked for this document is entitled to
> all of it.** The controller still reports the size so a caller can see what it cost.

That is Chapter 10's decision from the other end. The renderer returns the whole body; `core/guards.ts` clips it only when
the *host* is assembling a prompt. So this route returns a full document, and `chars` lets a caller see the cost — which is
what makes it a deliberate choice rather than an oversight.

---

## `src/controllers/promptController.ts` — the full file

```ts
import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import { PromptError } from "../core/errors.js";
import { textOf } from "../host/client.js";
import type { HostDeps } from "../host/deps.js";
import { query } from "../middleware/requestContext.js";

/**
 * Notes Ch06 §6.7 and Ch07 §7.3 — the **user-controlled** primitive.
 *
 * The two routes are `prompts/list` and `prompts/get`, and the single most
 * important thing about this file is what it does **not** do: it never calls a
 * model.
 *
 * That is not a simplification. It is the lecture's sharpest distinction —
 * *`MCP Prompt ≠ LLM Response`* — and the response bodies say so explicitly,
 * because a caller who confuses the two will build a UI that thinks it has an
 * answer when it only has a question.
 *
 *   `GET /prompts`  → what workflows exist, and with which arguments
 *   `GET /prompt`   → the messages for one workflow, with arguments substituted
 *
 * The model call, if there is one, is a *separate* step, taken by a route that
 * chose to take it. `GET /plan` is that route; this one is not.
 */
export function promptController(deps: HostDeps) {
  /**
   * The menu, memoised.
   *
   * The host lists prompts to render its own UI, so it already knows the names —
   * and knowing them is what turns an unknown prompt into a **404 before any
   * call is made**. The alternative is to call the server and try to recover the
   * class from the wire, and that does not work here: the SDK validates the
   * prompt name itself and reports `InvalidParams` (-32602), which is
   * indistinguishable from a genuinely malformed argument.
   *
   * The general lesson is worth keeping: *a host that can predict a failure
   * should predict it, rather than parse the server's error for it.*
   */
  let menu: string[] | undefined;

  const knownPrompts = async (): Promise<string[]> => {
    menu ??= (await deps.client.listPrompts()).map((prompt) => prompt.name);
    return menu;
  };

  return {
    /**
     * The menu.
     *
     * Notes Ch06 §6.6 — a prompt *advertises* its arguments, so a client can
     * render a form instead of making the user guess. That advertisement comes
     * from the server (`prompts/list`), not from a table here, which is what
     * stops the menu and the validator from drifting apart.
     */
    list: async (request: Request, response: Response): Promise<void> => {
      const session = request.session;
      const prompts = await deps.client.listPrompts();

      response.json({
        prompts: prompts.map((prompt) => {
          const decision = deps.policy.mayUsePrompt(prompt.name, session);

          return {
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            // `arguments` is optional in the protocol: a prompt may take none,
            // and reporting `[]` rather than omitting the key keeps a client's
            // form-rendering branch simple.
            arguments: (prompt.arguments ?? []).map((argument) => ({
              name: argument.name,
              description: argument.description,
              required: argument.required ?? false,
            })),
            // The host's own view, which is not the same as the server's: a
            // deployment may offer a prompt the server registers and still
            // refuse to surface it (Notes Ch06 §"Keep the count small").
            offered: decision.allowed,
            ...(decision.allowed ? {} : { reason: decision.reason }),
          };
        }),
        count: prompts.length,
      });
    },

    /**
     * Render one prompt.
     *
     * Every query parameter other than `name` is treated as an argument, so
     * `?name=plan_day&availableHours=4` reads the way the protocol does. The
     * server is the authority on what those arguments must be — it validates and
     * refuses with a message naming the offending field — and this controller
     * deliberately does not duplicate that check. Two validators for one contract
     * is two things to keep in sync.
     */
    get: async (request: Request, response: Response): Promise<void> => {
      const name = query(request, "name")?.trim();

      if (name === undefined || name === "") {
        throw new PromptError(
          "INVALID_INPUT",
          "Query parameter 'name' is required.",
          "Call GET /prompts to read the available names, then pass one as ?name=plan_day.",
        );
      }

      const session = request.session;

      // Predict the failure rather than parse it: an unknown name is a 404, and
      // no round trip is needed to know that.
      const names = await knownPrompts();

      if (!names.includes(name)) {
        deps.metrics.count("prompt.unknown");

        throw new PromptError(
          "NOT_FOUND",
          `Unknown prompt: "${name}".`,
          `Call GET /prompts to read the available names (${names.join(", ")}).`,
        );
      }

      const decision = deps.policy.mayUsePrompt(name, session);

      if (!decision.allowed) {
        deps.metrics.count("prompt.denied");
        throw new PromptError(
          "FORBIDDEN",
          `Refused to render ${name} — ${decision.reason}.`,
          "Use a workflow this deployment offers, or ask an administrator to enable it.",
        );
      }

      const args: Record<string, string> = {};

      for (const [key, value] of Object.entries(request.query)) {
        if (key !== "name" && typeof value === "string") {
          args[key] = value;
        }
      }

      const startedAt = performance.now();
      const rendered = await deps.client.getPrompt(name, args);
      const durationMs = performance.now() - startedAt;

      const messages = rendered.messages.map((message) => ({
        role: message.role,
        text: textOf({ content: [message.content] }),
      }));

      deps.audit.record({
        actor: session.actor,
        action: "prompt",
        target: name,
        decision: "allowed",
        outcome: "ok",
        // The argument *values* are hashed, never stored: a prompt argument is
        // whatever a user typed, which is exactly the kind of thing a log should
        // not keep (Notes Ch06 §"Prompt hygiene" — no secrets in a prompt, and
        // none in the record of it either).
        args,
        durationMs,
        note: `${messages.length} message(s), args: ${Object.keys(args).join(",") || "none"}`,
      });

      response.json({
        name,
        description: rendered.description,
        messages,
        /**
         * Stated in the payload because it is the whole point of the route.
         *
         * A caller that treats `messages` as an answer will build the wrong
         * thing; a caller that reads this field cannot.
         */
        modelCalled: false,
        note:
          "This is a message template, not an answer. prompts/get talks to the MCP server; the LLM call happens afterwards, elsewhere.",
      });
    },
  };
}
```

### Block-by-block

**Block 8 — the header, and the file's central negative (lines 7–22).**

> The two routes are `prompts/list` and `prompts/get`, and the single most important thing about this file is what it does
> **not** do: it never calls a model.
>
> That is not a simplification. It is the lecture's sharpest distinction — *`MCP Prompt ≠ LLM Response`* — and the response
> bodies say so explicitly, because **a caller who confuses the two will build a UI that thinks it has an answer when it
> only has a question.**

*A UI that thinks it has an answer when it only has a question* is the concrete harm, and it is a UI bug that is invisible
in code review. So the controller states the fact in the payload rather than relying on documentation — see Block 10.

**Block 9 — the memoised menu, and predicting a failure (lines 24–40).**

```ts
let menu: string[] | undefined;

const knownPrompts = async (): Promise<string[]> => {
  menu ??= (await deps.client.listPrompts()).map((prompt) => prompt.name);
  return menu;
};
```

The doc comment is one of the most instructive passages in the project:

> The host lists prompts to render its own UI, so it already knows the names — and knowing them is what turns an unknown
> prompt into a **404 before any call is made**. The alternative is to call the server and try to recover the class from
> the wire, and that does not work here: **the SDK validates the prompt name itself and reports `InvalidParams` (-32602),
> which is indistinguishable from a genuinely malformed argument.**
>
> The general lesson is worth keeping: *a host that can predict a failure should predict it, rather than parse the
> server's error for it.*

That is the reasoning behind a design decision that looks like an optimisation and is actually a correctness fix. The
problem: `prompts/get` with an unknown name fails at the *SDK's* router, before our `PromptError("NOT_FOUND", …)` is ever
reached — so the wire carries `InvalidParams`, which is also what a bad argument produces. **The host cannot distinguish
them from the error.**

So it does not try. It reads the menu once and answers 404 itself, from its own knowledge. Three details:

**`menu ??=` is a lazy cache** — the first call populates it, later calls reuse it. So the round trip happens once per
controller lifetime, not once per request.

**The cache is never invalidated**, which is correct here because the prompt set is fixed at boot (Chapter 11). A server
that could add prompts at runtime would need `notifications/prompts/list_changed` — and that is exactly the kind of
assumption a comment should state rather than leave implicit.

**This is why the host holds its own copy of things.** Same instinct as the resource catalogue copy in `routes/index.ts`
(Chapter 23): *shared source, not shared state.* The host knows what exists because it asked once, and it uses that
knowledge to answer questions the server's error channel cannot.

**Block 10 — `list`, the menu with the host's verdict attached (lines 42–80).**

```ts
list: async (request: Request, response: Response): Promise<void> => {
  const session = request.session;
  const prompts = await deps.client.listPrompts();

  response.json({
    prompts: prompts.map((prompt) => {
      const decision = deps.policy.mayUsePrompt(prompt.name, session);

      return {
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: (prompt.arguments ?? []).map((argument) => ({
          name: argument.name,
          description: argument.description,
          required: argument.required ?? false,
        })),
        offered: decision.allowed,
        ...(decision.allowed ? {} : { reason: decision.reason }),
      };
    }),
    count: prompts.length,
  });
}
```

**The menu comes from the server, not from a table here** — *which is what stops the menu and the validator from drifting
apart.* So the arguments a client renders a form for are the arguments `prompts/get` will validate against (Chapter 11's
single source of truth, all the way out to the HTTP surface).

**`arguments: (prompt.arguments ?? []).map(…)`** — the `?? []` is the comment's point: *`arguments` is optional in the
protocol: a prompt may take none, and reporting `[]` rather than omitting the key keeps a client's form-rendering branch
simple.* So `review_workload` reports `arguments: []`, and a client has one branch rather than two.

**`required: argument.required ?? false`** — the protocol's `required` is optional, and defaulting to `false` is the safe
direction for a *form*: a field marked optional that turns out to be required produces a server error the user can read,
while a field marked required that is actually optional blocks a submission that would have worked.

**`offered` plus a conditional `reason` is the host's verdict layered on the server's menu:**

```ts
offered: decision.allowed,
...(decision.allowed ? {} : { reason: decision.reason }),
```

*The host's own view, which is not the same as the server's: a deployment may offer a prompt the server registers and still
refuse to surface it.* So the menu is **complete** and annotated, rather than filtered — a client can render all three
workflows and disable two. Chapter 20's verify section showed exactly that: `plan_day offered=true`,
`review_workload offered=false`, `weekly_plan offered=false`.

And the `reason` is only present when refused, so the response does not carry a redundant field for the common case.

**Block 11 — `get`, three gates before the call (lines 82–183).**

```ts
get: async (request: Request, response: Response): Promise<void> => {
  const name = query(request, "name")?.trim();

  if (name === undefined || name === "") {
    throw new PromptError("INVALID_INPUT", "Query parameter 'name' is required.", "Call GET /prompts to read the available names, then pass one as ?name=plan_day.");
  }

  const session = request.session;
  const names = await knownPrompts();

  if (!names.includes(name)) {
    deps.metrics.count("prompt.unknown");

    throw new PromptError("NOT_FOUND", `Unknown prompt: "${name}".`, `Call GET /prompts to read the available names (${names.join(", ")}).`);
  }

  const decision = deps.policy.mayUsePrompt(name, session);

  if (!decision.allowed) {
    deps.metrics.count("prompt.denied");
    throw new PromptError("FORBIDDEN", `Refused to render ${name} — ${decision.reason}.`, "Use a workflow this deployment offers, or ask an administrator to enable it.");
  }

  const args: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.query)) {
    if (key !== "name" && typeof value === "string") {
      args[key] = value;
    }
  }

  const startedAt = performance.now();
  const rendered = await deps.client.getPrompt(name, args);
  const durationMs = performance.now() - startedAt;

  const messages = rendered.messages.map((message) => ({ role: message.role, text: textOf({ content: [message.content] }) }));

  deps.audit.record({ actor: session.actor, action: "prompt", target: name, decision: "allowed", outcome: "ok", args, durationMs, note: `${messages.length} message(s), args: ${Object.keys(args).join(",") || "none"}` });

  response.json({
    name,
    description: rendered.description,
    messages,
    modelCalled: false,
    note: "This is a message template, not an answer. prompts/get talks to the MCP server; the LLM call happens afterwards, elsewhere.",
  });
}
```

**Three gates, in order, before the server is called at all:**

| Gate | Check | Failure |
| :--- | :--- | :--- |
| 1 | Is `name` present? | **400** `INVALID_INPUT` |
| 2 | Is it a known prompt? (from the memoised menu) | **404** `NOT_FOUND`, with the real names |
| 3 | Does the deployment offer it? | **403** `FORBIDDEN` |

The second gate is the predict-don't-parse design from Block 9, and its recovery sentence lists the actual menu —
`Call GET /prompts to read the available names (plan_day, review_workload, weekly_plan).` — generated from the cached names,
so it cannot name a prompt that does not exist.

The third gate is the prompt allowlist applied on the *action* path as well as the listing path — so a client that somehow
learned a name still cannot render it. **Both places, because a listing is a hint and a call is the act.**

**The argument extraction is the elegant bit:**

```ts
for (const [key, value] of Object.entries(request.query)) {
  if (key !== "name" && typeof value === "string") {
    args[key] = value;
  }
}
```

*Every query parameter other than `name` is treated as an argument, so `?name=plan_day&availableHours=4` reads the way the
protocol does.* So the URL shape mirrors the protocol's `arguments` object — no `?args=` JSON blob, no per-prompt route.

And the `typeof value === "string"` guard handles Express's type: a query parameter can be a string *or an array* (for a
repeated key). An array would not satisfy `Record<string, string>`, so it is dropped rather than coerced — which is the
right call for an argument the server will validate anyway.

**The controller does not validate the arguments, and the doc comment says why:** *the server is the authority on what
those arguments must be — it validates and refuses with a message naming the offending field — and this controller
deliberately does not duplicate that check. **Two validators for one contract is two things to keep in sync.***

That is a deliberate asymmetry with the *name* check. The name is checked here because the host **can** — it has the menu,
and the server's error for an unknown name is indistinguishable from a bad argument (Block 9). The arguments are *not*
checked because the host **cannot do better** than the server: the schema lives on the server, and duplicating it would
mean maintaining two copies of one contract. **Check what you can predict; delegate what you cannot.**

**The audit record hashes the arguments** — `args,` not `argsHash` — because `createAuditLog` does the hashing
(Chapter 22). The comment states the rule: *a prompt argument is whatever a user typed, which is exactly the kind of thing
a log should not keep.* And the `note` records only the argument **names**:

```ts
note: `${messages.length} message(s), args: ${Object.keys(args).join(",") || "none"}`,
```

Same discipline as Chapter 16's `argNames` — names, never values.

**And the response's last two fields are the file's whole point:**

```ts
modelCalled: false,
note: "This is a message template, not an answer. prompts/get talks to the MCP server; the LLM call happens afterwards, elsewhere.",
```

The doc comment on `modelCalled` says why it is in the payload: *a caller that treats `messages` as an answer will build the
wrong thing; a caller that reads this field cannot.* That is the right place for the distinction — **in the data, not only
in the documentation**, because a UI author reads the response.

---

## `src/controllers/planController.ts` — the full file

```ts
import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import { PromptError } from "../core/errors.js";
import { textOf } from "../host/client.js";
import { assembleContext, type AssembledContext } from "../host/context.js";
import type { HostDeps } from "../host/deps.js";
import { askModel, type ModelReply } from "../host/model.js";
import { query } from "../middleware/requestContext.js";
import type { PromptMessage } from "../services/promptService.js";

/**
 * Notes Ch08 §8.2 — **the request the whole lecture builds towards:**
 *
 * ```text
 * GET /plan?hours=4
 * ```
 *
 * One request, three primitives, three owners. The lecture walks it in three
 * steps and this file performs them in the same order, which is why the response
 * carries an explicit `steps` array: the flow is the lesson, so the flow is what
 * the endpoint reports.
 *
 *   1. **User controls the Prompt.**            `prompts/get plan_day { availableHours }`
 *   2. **Application controls the Resource.**   select → authorise → read → budget
 *   3. **Model controls the Tool.**             the prompt *asks*; the model decides
 *
 * The third step is the one this file cannot perform for the model, and that is
 * the point of the design rather than a gap in it: `plan_day` names `list_tasks`
 * because the model has to choose to call it. Notes Ch07 §7.2 — *"the prompt is a
 * nudge, not a command."*
 */

/** One step of the flow, reported so the response explains itself. */
interface Step {
  step: number;
  controlledBy: "user" | "application" | "model";
  primitive: "prompt" | "resource" | "tool";
  detail: string;
}

interface PipelineResult {
  steps: Step[];
  context: AssembledContext;
  reply: ModelReply;
  promptName?: string;
  promptMessages: PromptMessage[];
  promptDurationMs: number;
}

/**
 * The shared pipeline behind `/plan` and `/ask`.
 *
 * Both routes run the same three steps; they differ only in whether step 1 is a
 * *prompt the user selected* or *a message the user typed*. Writing it once is
 * what makes that difference visible instead of buried in two near-identical
 * handlers.
 */
async function runPipeline(
  deps: HostDeps,
  input: {
    message: string;
    session: { actor: string; projects: readonly string[]; isAdmin: boolean };
    prompt?: { name: string; args: Record<string, string> };
  },
): Promise<PipelineResult> {
  const steps: Step[] = [];
  let promptMessages: PromptMessage[] = [];
  let promptDurationMs = 0;

  /* ── Step 1 — the USER controls the prompt (Notes Ch08 §8.2) ───────────── */

  if (input.prompt !== undefined) {
    const { name, args } = input.prompt;
    const decision = deps.policy.mayUsePrompt(name, input.session);

    if (!decision.allowed) {
      throw new PromptError(
        "FORBIDDEN",
        `Refused to render ${name} — ${decision.reason}.`,
        "Use a workflow this deployment offers, or ask an administrator to enable it.",
      );
    }

    const startedAt = performance.now();
    const rendered = await deps.client.getPrompt(name, args);
    promptDurationMs = performance.now() - startedAt;

    promptMessages = rendered.messages.map((message) => ({
      role: message.role as PromptMessage["role"],
      text: textOf({ content: [message.content] }),
    }));

    deps.audit.record({
      actor: input.session.actor,
      action: "prompt",
      target: name,
      decision: "allowed",
      outcome: "ok",
      args,
      durationMs: promptDurationMs,
      note: `${promptMessages.length} message(s)`,
    });

    steps.push({
      step: 1,
      controlledBy: "user",
      primitive: "prompt",
      detail:
        `prompts/get ${name} ${JSON.stringify(args)} → ${promptMessages.length} message(s) in ` +
        `${Math.round(promptDurationMs)} ms. The prompt supplies instructions, never facts.`,
    });
  } else {
    steps.push({
      step: 1,
      controlledBy: "user",
      primitive: "prompt",
      detail: "No prompt selected — the user typed the message directly. The rest of the pipeline is unchanged.",
    });
  }

  /* ── Step 2 — the APPLICATION controls the resources (Notes Ch05) ──────── */

  const context = await assembleContext(
    {
      message: input.message,
      session: input.session,
      promptMessages,
    },
    {
      client: deps.client,
      policy: deps.policy,
      selection: deps.selection,
      budget: deps.budget,
      logger: deps.logger,
      metrics: deps.metrics,
      maxResourcesPerRequest: deps.limits.maxResourcesPerRequest,
    },
  );

  const strategies = context.selection.strategies.join(", ") || "none";
  const chosen = context.selection.chosen
    .map((selection) => `${selection.uri} ← ${selection.strategy}`)
    .join("; ");

  steps.push({
    step: 2,
    controlledBy: "application",
    primitive: "resource",
    detail:
      context.selection.chosen.length === 0
        ? `No Resource selected (strategies consulted: ${strategies}; ${context.selection.candidates} candidates).`
        : `Selected ${context.selection.chosen.length} of ${context.selection.candidates} candidates via ` +
          `[${strategies}]: ${chosen}. Read ${context.included.length}, budgeted to ${context.chars} chars` +
          `${context.truncated.length > 0 ? `, truncated ${context.truncated.length}` : ""}` +
          `${context.dropped.length > 0 ? `, dropped ${context.dropped.length}` : ""}.`,
  });

  /* ── Step 3 — the MODEL controls any tool call (Notes Ch07 §7.1) ───────── */

  const reply = await askModel({
    system: context.system,
    messages: context.messages,
    logger: deps.logger,
    metrics: deps.metrics,
  });

  steps.push({
    step: 3,
    controlledBy: "model",
    primitive: "tool",
    detail:
      reply.source === "model"
        ? `${reply.model} answered. Any tool call it made — list_tasks, most likely — was its own decision, ` +
          `taken because the prompt named the capability and the model judged it necessary.`
        : "No model configured, so the assembled request is echoed instead. The prompt still names list_tasks " +
          "and the tool is still registered — the model's decision is the only step missing.",
  });

  return {
    steps,
    context,
    reply,
    ...(input.prompt === undefined ? {} : { promptName: input.prompt.name }),
    promptMessages,
    promptDurationMs,
  };
}

/**
 * The two flows.
 *
 * `/plan` is the lecture's request: a **prompt** starts it, so the user chose the
 * workflow. `/ask` is the same pipeline with no prompt, so the user typed a
 * question directly — and the contrast is the demonstration: the Resource
 * selection and the model step are *identical* in both, which is what it means
 * for the primitives to compose rather than to be alternatives.
 */
export function planController(deps: HostDeps) {
  return {
    /** `GET /plan?hours=4` — Notes Ch08 §8.2, end to end. */
    plan: async (request: Request, response: Response): Promise<void> => {
      const hours = query(request, "hours")?.trim() || "4";
      const session = request.session;
      const startedAt = performance.now();

      const result = await runPipeline(deps, {
        // The message is *derived from the prompt's arguments*, because in this
        // flow the prompt is the message. `/ask` is where the user supplies one.
        message: `Plan my day with ${hours} hours available.`,
        session,
        prompt: { name: "plan_day", args: { availableHours: hours } },
      });

      const durationMs = performance.now() - startedAt;

      deps.metrics.count("plan.ok");
      deps.metrics.observe("plan.latency_ms", durationMs);

      response.json({
        request: { hours, actor: session.actor, projects: session.projects, admin: session.isAdmin },
        steps: result.steps,
        context: {
          system: result.context.system,
          included: result.context.included,
          dropped: result.context.dropped,
          refused: result.context.refused,
          failed: result.context.failed,
          truncated: result.context.truncated,
          chars: result.context.chars,
          selections: result.context.selection.chosen,
        },
        prompt: { name: result.promptName, messages: result.promptMessages },
        answer: { source: result.reply.source, model: result.reply.model, text: result.reply.text },
        ms: Math.round(durationMs),
      });
    },

    /** `GET /ask?message=...` — the same pipeline, with the user's own words. */
    ask: async (request: Request, response: Response): Promise<void> => {
      const message = query(request, "message")?.trim();

      if (message === undefined || message === "") {
        throw new PromptError(
          "INVALID_INPUT",
          "Query parameter 'message' is required.",
          "Try GET /ask?message=what+is+on+my+plate.",
        );
      }

      const session = request.session;
      const startedAt = performance.now();

      const result = await runPipeline(deps, { message, session });
      const durationMs = performance.now() - startedAt;

      deps.metrics.count("ask.ok");
      deps.metrics.observe("ask.latency_ms", durationMs);

      response.json({
        request: { message, actor: session.actor, projects: session.projects },
        steps: result.steps,
        context: {
          system: result.context.system,
          included: result.context.included,
          dropped: result.context.dropped,
          refused: result.context.refused,
          failed: result.context.failed,
          chars: result.context.chars,
          selections: result.context.selection.chosen,
        },
        answer: { source: result.reply.source, model: result.reply.model, text: result.reply.text },
        ms: Math.round(durationMs),
      });
    },
  };
}
```

### Block-by-block

**Block 12 — the header, and the flow as the lesson (lines 11–33).**

> One request, three primitives, three owners. The lecture walks it in three steps and this file performs them in the same
> order, which is why **the response carries an explicit `steps` array: the flow is the lesson, so the flow is what the
> endpoint reports.**
>
> ```text
> 1. User controls the Prompt.           prompts/get plan_day { availableHours }
> 2. Application controls the Resource.  select → authorise → read → budget
> 3. Model controls the Tool.            the prompt *asks*; the model decides
> ```
>
> The third step is the one this file cannot perform for the model, and that is the point of the design rather than a gap
> in it: `plan_day` names `list_tasks` because the model has to choose to call it. Notes Ch07 §7.2 — *"the prompt is a
> nudge, not a command."*

**The `steps` array in the response is a teaching decision made in the API.** The endpoint reports its own architecture, so
a reader can see the three owners without reading any code — and the third step's text explicitly says the model's decision
is *missing* rather than pretending the flow completed.

**Block 13 — `Step` and `PipelineResult` (lines 35–48).**

```ts
interface Step {
  step: number;
  controlledBy: "user" | "application" | "model";
  primitive: "prompt" | "resource" | "tool";
  detail: string;
}
```

Four fields, and the two unions encode the lecture's mapping directly: `controlledBy` names the *owner* and `primitive`
names the *mechanism*. They are correlated (user→prompt, application→resource, model→tool) and they are kept as separate
fields rather than one enum, because a future step could legitimately break the correlation — and because the response is
meant to *teach* the distinction, which two fields do better than one.

**Block 14 — `runPipeline`, and why both routes share it (lines 50–61).**

> Both routes run the same three steps; they differ only in whether step 1 is a *prompt the user selected* or *a message the
> user typed*. **Writing it once is what makes that difference visible instead of buried in two near-identical handlers.**

That is the payoff: `/plan` and `/ask` share a pipeline, so the *only* difference between them is `input.prompt` being
defined or not. Two near-identical handlers would have hidden the very contrast the routes exist to demonstrate.

**Block 15 — step 1, the prompt (lines 63–115).**

The prompt branch checks the policy, renders, converts the messages and audits — the same three gates as
`promptController.get`, minus the name check (the name is a literal in the caller). And it pushes a step whose detail is
self-describing:

```ts
detail:
  `prompts/get ${name} ${JSON.stringify(args)} → ${promptMessages.length} message(s) in ` +
  `${Math.round(promptDurationMs)} ms. The prompt supplies instructions, never facts.`,
```

*"The prompt supplies instructions, never facts"* — Chapter 11's rule 2 stated in the API's own output, so a reader of the
response learns the design.

The `else` branch is `/ask`'s case, and its detail is honest about what changed:

```ts
detail: "No prompt selected — the user typed the message directly. The rest of the pipeline is unchanged.",
```

**Block 16 — step 2, the resources, and the detail string (lines 117–160).**

```ts
const context = await assembleContext(
  { message: input.message, session: input.session, promptMessages },
  {
    client: deps.client,
    policy: deps.policy,
    selection: deps.selection,
    budget: deps.budget,
    logger: deps.logger,
    metrics: deps.metrics,
    maxResourcesPerRequest: deps.limits.maxResourcesPerRequest,
  },
);
```

**The whole of Chapter 21, in one call.** The controller supplies seven collaborators and gets back an
`AssembledContext` — and note it passes `promptMessages` *in*, which is how the prompt's messages travel through to the
model input (Chapter 21's `AssembleRequest.promptMessages`).

Then the step's detail summarises the decision in one sentence:

```ts
detail:
  context.selection.chosen.length === 0
    ? `No Resource selected (strategies consulted: ${strategies}; ${context.selection.candidates} candidates).`
    : `Selected ${context.selection.chosen.length} of ${context.selection.candidates} candidates via ` +
      `[${strategies}]: ${chosen}. Read ${context.included.length}, budgeted to ${context.chars} chars` +
      `${context.truncated.length > 0 ? `, truncated ${context.truncated.length}` : ""}` +
      `${context.dropped.length > 0 ? `, dropped ${context.dropped.length}` : ""}.`,
```

Four decisions in one expression, and each is the right one:

**The empty case is a different sentence, not a zero.** *No Resource selected (strategies consulted: state; 0 candidates)*
is informative; *Selected 0 of 0* is not.

**`chosen` pairs each URI with its strategy** — `` `${selection.uri} ← ${selection.strategy}` `` — so the sentence reads
`task://backlog ← retrieval`. That is Chapter 12's provenance surfacing in the API output.

**`truncated` and `dropped` are only mentioned when non-zero**, via the conditional interpolation. So a clean request
produces a short sentence, and a request where something went wrong produces a longer one that names it. **The detail
string's length is a signal.**

**Block 17 — step 3, the model, and the honest branch (lines 162–178).**

```ts
const reply = await askModel({ system: context.system, messages: context.messages, logger: deps.logger, metrics: deps.metrics });

steps.push({
  step: 3,
  controlledBy: "model",
  primitive: "tool",
  detail:
    reply.source === "model"
      ? `${reply.model} answered. Any tool call it made — list_tasks, most likely — was its own decision, ` +
        `taken because the prompt named the capability and the model judged it necessary.`
      : "No model configured, so the assembled request is echoed instead. The prompt still names list_tasks " +
        "and the tool is still registered — the model's decision is the only step missing.",
});
```

**The offline branch is the most careful sentence in the file:** *the prompt still names `list_tasks` and the tool is still
registered — **the model's decision is the only step missing**.* It says exactly what is and is not happening, so a reader
of the response knows the Tool primitive is wired and merely unexercised. That is the difference between an honest offline
mode and a misleading one.

**Block 18 — the two routes (lines 180–276).**

```ts
plan: async (context) => {
  const hours = query(request, "hours")?.trim() || "4";
  const session = request.session;
  const startedAt = performance.now();

  const result = await runPipeline(deps, {
    message: `Plan my day with ${hours} hours available.`,
    session,
    prompt: { name: "plan_day", args: { availableHours: hours } },
  });

  const durationMs = performance.now() - startedAt;

  deps.metrics.count("plan.ok");
  deps.metrics.observe("plan.latency_ms", durationMs);

  response.json({ request: {…}, steps: result.steps, context: {…}, prompt: {…}, answer: {…}, ms: Math.round(durationMs) });
}
```

**`hours` defaults to `"4"`** — `?.trim() || "4"` — so `GET /plan` works with no parameter. That is the right default for a
demo endpoint: the lecture's request is `?hours=4`, and omitting it gives the same thing.

**The message is derived from the arguments**, and the comment names the design: *the message is derived from the prompt's
arguments, because in this flow the prompt is the message. `/ask` is where the user supplies one.* So `plan` builds a
message from the prompt's parameter, which is what makes the *selection* step meaningful — the retrieval strategy scores
that derived message against the catalogue (which is why the reason reads *"the message scores 0.17"* for the plan flow).

**The response is a composition of five parts** — `request`, `steps`, `context`, `prompt`, `answer`, `ms` — so one response
describes the whole pipeline. And `context` includes all six of Chapter 21's lists (`included`, `dropped`, `refused`,
`failed`, `truncated`, `chars`) plus `selections`, so a caller can see exactly what was and was not used.

`answer: { source: result.reply.source, … }` carries `"offline"` in this deployment, which is how the endpoint reports its
own state rather than pretending.

`ask` is the same shape minus the prompt section, and it validates `message` with the same 400 pattern. Its metrics are
`ask.ok` and `ask.latency_ms` — separate names, so the two flows can be compared in a dashboard.

---

## `src/routes/index.ts` — the full file

```ts
#!/usr/bin/env node
import express, { type Express, type Request, type Response } from "express";

import { env } from "../config/env.js";
import { createContextBudget } from "../core/guards.js";
import { createLogger } from "../core/logger.js";
import { createMetrics } from "../core/metrics.js";
import { healthController } from "../controllers/healthController.js";
import { planController } from "../controllers/planController.js";
import { promptController } from "../controllers/promptController.js";
import { resourceController } from "../controllers/resourceController.js";
import { createResourceCatalogue } from "../domain/resourceCatalogue.js";
import { createAuditLog } from "../host/audit.js";
import { createMcpClient } from "../host/client.js";
import type { HostDeps } from "../host/deps.js";
import { createHostPolicy, type ConsentHandler } from "../host/policy.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestContext } from "../middleware/requestContext.js";
import { createSelectionService } from "../services/selectionService.js";

/**
 * Notes Ch04 — **Host, Client and Server.**
 *
 * This process is the **host**: it owns the conversation, the policy and the user
 * experience, and it opens exactly one MCP **client** to exactly one server. The
 * server is the capability provider from `src/index.ts`, and it knows nothing
 * about this file.
 *
 * The file has two jobs, and separating them is what the layering is for:
 *
 *  1. **Compose** — build the dependency graph once, here, and hand it to the
 *     controllers. This is the host's composition root, the mirror of
 *     `mcp/server.ts`.
 *  2. **Route** — map a path to a controller method. That is genuinely all a
 *     router should do, and the routes below are one line each because every
 *     decision already lives somewhere else.
 *
 * Nothing in `controllers/` imports anything from this file, which is the
 * testability claim made concrete: a controller can be constructed from a
 * `HostDeps` object with no HTTP server, no port and no child process.
 */

const logger = createLogger(env.MCP_LOG_LEVEL, { host: "task-host" });
const metrics = createMetrics();

/**
 * The consent gate.
 *
 * **Denying by default is the only safe default**, and it is also the honest one
 * for this surface: the HTTP host never calls a tool — it reads Resources and
 * renders Prompts — so this handler is never reached in normal operation.
 *
 * A real host renders a dialog and awaits a click. The scripted, deterministic
 * version used by `npm run lifecycle` is injected there instead, which is why
 * this is a parameter rather than a hard-coded `confirm()`.
 */
const requestConsent: ConsentHandler = async ({ tool, args }) => {
  logger.warn("consent.not_implemented", {
    tool,
    args: Object.keys(args),
    note: "the HTTP host does not invoke tools; use npm run lifecycle for the scripted gate",
  });

  return false;
};

/** The composition root: build every layer once, in dependency order. */
async function createHost(): Promise<{ deps: HostDeps; close: () => Promise<void> }> {
  const client = await createMcpClient({ url: env.MCP_SERVER_URL, logger, metrics });

  /**
   * The host keeps its *own* copy of the catalogue.
   *
   * It is not fetched from the server, and that is deliberate: the ACL has to run
   * **before** a read, and asking the server "may I read this?" would be a round
   * trip that answers the wrong question — the server has no session. The
   * descriptor table is shared *source*, not shared state, so the two processes
   * agree on shape without either trusting the other's answer about ownership.
   */
  const catalogue = createResourceCatalogue();

  const policy = createHostPolicy({
    allowDestructive: env.MCP_HOST_ALLOW_DESTRUCTIVE,
    requireConsent: env.MCP_HOST_REQUIRE_CONSENT,
    allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES),
    catalogue,
    allowedPrompts: env.MCP_HOST_ALLOWED_PROMPTS,
    requestConsent,
    logger,
  });

  const budget = createContextBudget({
    maxResources: env.MCP_MAX_RESOURCES_PER_REQUEST,
    maxResourceChars: env.MCP_MAX_RESOURCE_CHARS,
    maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
  });

  const selection = createSelectionService({ catalogue });
  const audit = createAuditLog(logger);

  const deps: HostDeps = {
    client,
    policy,
    selection,
    budget,
    audit,
    logger,
    metrics,
    limits: {
      maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
      maxResourceChars: env.MCP_MAX_RESOURCE_CHARS,
      maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
    },
  };

  return { deps, close: () => client.close() };
}

const { deps, close } = await createHost();

const health = healthController(deps);
const resources = resourceController(deps);
const prompts = promptController(deps);
const plan = planController(deps);

const app: Express = express();

// Express would otherwise advertise itself with `X-Powered-By: Express`. The
// Hono binding sent no such header, and swapping the framework should not change
// the bytes on the wire — so it goes off.
app.disable("x-powered-by");

/**
 * Middleware first, in the order it must run.
 *
 * `app.use(requestContext(...))` with no path matches every request — the
 * Express spelling of Hono's `app.use("*", …)`. (Express 5 routes on
 * path-to-regexp v8, where a bare `"*"` is no longer a valid pattern; omitting
 * the path is both correct and clearer.)
 */
app.use(requestContext({ logger, metrics }));

/**
 * The route table. Each line is a path and a controller method — no logic, which
 * is the point of having controllers at all.
 */
app.get("/", health.index);
app.get("/health", health.health);
app.get("/metrics", health.metrics);

// Notes Ch03 §3.1 — discovery is not consumption.
app.get("/resources", resources.list);
app.get("/read", resources.read);

// Notes Ch06/07 — the user's primitive, and never a model call.
app.get("/prompts", prompts.list);
app.get("/prompt", prompts.get);

// Notes Ch08 §8.2 — one request, three primitives, three owners.
app.get("/plan", plan.plan);
app.get("/ask", plan.ask);

/**
 * The 404, as a catch-all registered *after* every route.
 *
 * Hono had `app.notFound(...)` for this. Express has no dedicated hook, and does
 * not need one: an ordinary two-argument `app.use` runs only when nothing above
 * it matched, which is the same behaviour with one fewer API to learn.
 */
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});

/**
 * The error handler, last — and its *position* is load-bearing.
 *
 * Hono's `app.onError(...)` could be registered above the routes, because Hono
 * keeps a raised error out of the middleware chain until it unwinds. Express
 * matches in registration order, so an error handler placed above the routes
 * would never see a failure they raised; it has to come after them. The four
 * parameters are what mark it as an error handler rather than ordinary
 * middleware, and Chapter 24 takes that apart.
 */
app.use(errorHandler({ logger, metrics }));

const httpServer = app.listen(env.MCP_HOST_PORT, "127.0.0.1", () => {
  logger.info("host.listening", {
    url: `http://127.0.0.1:${env.MCP_HOST_PORT}`,
    server: env.MCP_SERVER_URL,
    model: env.OPENAI_API_KEY === "" ? "offline" : env.OPENAI_MODEL,
  });
});

/**
 * Graceful shutdown, in the right order: stop accepting requests, then close the
 * MCP session. Closing the client first would fail the requests already in
 * flight, which is the opposite of graceful.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("host.shutdown", { signal });

    httpServer.close(() => {
      void close().finally(() => process.exit(0));
    });
  });
}
```

### Block-by-block

**Block 19 — the header: two jobs, separated (lines 22–42).**

> This process is the **host**: it owns the conversation, the policy and the user experience, and it opens exactly one MCP
> **client** to exactly one server. The server is the capability provider from `src/index.ts`, and it knows nothing about
> this file.
>
> The file has two jobs, and separating them is what the layering is for:
>
> 1. **Compose** — build the dependency graph once, here, and hand it to the controllers. This is the host's composition
>    root, the mirror of `mcp/server.ts`.
> 2. **Route** — map a path to a controller method. That is genuinely all a router should do, and the routes below are one
>    line each because every decision already lives somewhere else.
>
> Nothing in `controllers/` imports anything from this file, which is the testability claim made concrete: a controller can
> be constructed from a `HostDeps` object with no HTTP server, no port and no child process.

**One file, two jobs, and the second one is deliberately trivial.** The route table is nine one-line registrations, which
is the sign that the layering worked: if the routes needed logic, some decision would be living in the wrong place.

**Block 20 — the composition root, `createHost` (lines 44–118).**

```ts
async function createHost(): Promise<{ deps: HostDeps; close: () => Promise<void> }> {
  const client = await createMcpClient({ url: env.MCP_SERVER_URL, logger, metrics });

  const catalogue = createResourceCatalogue();

  const policy = createHostPolicy({
    allowDestructive: env.MCP_HOST_ALLOW_DESTRUCTIVE,
    requireConsent: env.MCP_HOST_REQUIRE_CONSENT,
    allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES),
    catalogue,
    allowedPrompts: env.MCP_HOST_ALLOWED_PROMPTS,
    requestConsent,
    logger,
  });

  const budget = createContextBudget({
    maxResources: env.MCP_MAX_RESOURCES_PER_REQUEST,
    maxResourceChars: env.MCP_MAX_RESOURCE_CHARS,
    maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
  });

  const selection = createSelectionService({ catalogue });
  const audit = createAuditLog(logger);

  const deps: HostDeps = { client, policy, selection, budget, audit, logger, metrics, limits: {…} };

  return { deps, close: () => client.close() };
}
```

**The order is the dependency order**, and it is the mirror of `mcp/server.ts` (Chapter 17): the client first (it is the
only thing that can fail to connect), then the catalogue, then the policy and the budget which both need it, then the
selection engine, then the audit log.

**The host keeps its *own* catalogue**, and the comment is one of the most important in the project:

> The host keeps its *own* copy of the catalogue. It is not fetched from the server, and that is deliberate: **the ACL has
> to run *before* a read, and asking the server "may I read this?" would be a round trip that answers the wrong question —
> the server has no session.** The descriptor table is **shared *source*, not shared state**, so the two processes agree on
> shape without either trusting the other's answer about ownership.

*Shared source, not shared state* is the phrase to keep. `createResourceCatalogue()` is called in **both** processes, from
the same module (Chapter 08), so the two catalogues are identical by construction rather than by synchronisation. And the
ACL can therefore run locally — no round trip, and no need for the server to know who is asking.

That is also why `budget` and `selection` take the same `catalogue` object: one descriptor table, three consumers, all in
one process.

**`requestConsent` is defined above, and it denies by default (lines 47–66).**

```ts
const requestConsent: ConsentHandler = async ({ tool, args }) => {
  logger.warn("consent.not_implemented", {
    tool,
    args: Object.keys(args),
    note: "the HTTP host does not invoke tools; use npm run lifecycle for the scripted gate",
  });

  return false;
};
```

**Denying is the only safe default**, and the comment says why it is also honest for this surface: *the HTTP host never
calls a tool — it reads Resources and renders Prompts — so this handler is never reached in normal operation.* So the
handler logs a warning naming the way to exercise the gate, and returns `false`.

That warning is a nice piece of design: if a future route *did* invoke a tool, the operator would see
`consent.not_implemented` with the tool name and the argument *names* — and a `false` means the call would be refused
rather than silently allowed. **A not-implemented path that fails closed and says so.**

**Block 21 — the wiring and the route table (lines 119–162).**

```ts
const { deps, close } = await createHost();

const health = healthController(deps);
const resources = resourceController(deps);
const prompts = promptController(deps);
const plan = planController(deps);

const app: Express = express();

app.disable("x-powered-by");
app.use(requestContext({ logger, metrics }));

app.get("/", health.index);
app.get("/health", health.health);
app.get("/metrics", health.metrics);

app.get("/resources", resources.list);
app.get("/read", resources.read);

app.get("/prompts", prompts.list);
app.get("/prompt", prompts.get);

app.get("/plan", plan.plan);
app.get("/ask", plan.ask);
```

**A top-level `await` at module scope** — `const { deps, close } = await createHost()` — which is legal because the project
is ESM. So the host connects to the server *before* it starts listening, and a failure to connect is a startup failure
rather than a per-request surprise.

**Middleware first, in the order it must run** — `app.use(requestContext(…))` is registered first, so every request has a
logger and a session. The error handler is registered **last**, after the routes: Express matches middleware in
registration order, so an error handler placed above the routes would never see a failure they raised. (Hono's
`app.onError` could sit at the top, because Hono keeps a raised error out of the chain until it unwinds.) That ordering is
what makes the access log complete — Chapter 24.

**Nine routes, each one line.** The path and the method, nothing else. And the grouping with blank lines and comments
mirrors the three primitives — discovery for resources, the prompt surface, and the composed request — which is what makes
the table readable as a description of the system rather than a list of endpoints.

**Block 22 — the 404 and the shutdown (lines 163–220).**

```ts
app.use((request: Request, response: Response) => {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `No route for ${request.method} ${request.path}.`,
      recovery: "Call GET / for the index of available routes.",
    },
  });
});
```

The 404 names the method and the path — so a client that mistyped a URL sees what it actually sent — and the recovery
points at `GET /`. It is a plain two-argument `app.use`, which Express runs only when nothing above it matched; that is
the entire mechanism, and it is why this handler has to be registered *after* the routes. It is also the handler whose
body shape differs from `errorHandler`'s, documented in Chapter 24: three fields rather than five, and no `requestId`.

```ts
const httpServer = app.listen(env.MCP_HOST_PORT, "127.0.0.1", () => {
  logger.info("host.listening", {
    url: `http://127.0.0.1:${env.MCP_HOST_PORT}`,
    server: env.MCP_SERVER_URL,
    model: env.OPENAI_API_KEY === "" ? "offline" : env.OPENAI_MODEL,
  });
});
```

**`hostname: "127.0.0.1"`** — loopback, explicitly, for the same reason as the server's bind (Chapter 18). And the boot log
reports the two URLs plus the model state, so one line tells an operator the whole configuration.

```ts
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("host.shutdown", { signal });

    httpServer.close(() => {
      void close().finally(() => process.exit(0));
    });
  });
}
```

**The shutdown order is the reverse of startup, and the comment says why:**

> Graceful shutdown, in the right order: **stop accepting requests, then close the MCP session.** Closing the client first
> would fail the requests already in flight, which is the opposite of graceful.

So `httpServer.close(callback)` — which stops accepting and invokes the callback once in-flight requests finish — and *then*
`close()` on the MCP client. The `finally` guarantees the exit, and `process.exit(0)` reports a clean shutdown.

The `shuttingDown` flag is the same double-signal guard as Chapter 18's, for the same reason: a second `SIGTERM` or a
double Ctrl-C must not run the sequence twice while the first is draining.

And note the client is closed through the `close` returned by `createHost()` rather than through `deps.client.close()` — a
small choice that keeps the teardown symmetric with the setup: `createHost` returns both halves of the lifecycle.

---

## Run / verify

### 1. All nine routes, by status

```bash
for u in / /health /metrics /resources '/read?uri=task://summary' /prompts '/prompt?name=plan_day&availableHours=4' '/plan?hours=4' '/ask?message=what%20is%20on%20my%20plate'; do
  printf '%-46s -> %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080$u")"
done
```

```text
/                                              -> 200
/health                                        -> 200
/metrics                                       -> 200
/resources                                     -> 200
/read?uri=task://summary                       -> 200
/prompts                                       -> 200
/prompt?name=plan_day&availableHours=4         -> 200
/plan?hours=4                                  -> 200
/ask?message=what%20is%20on%20my%20plate       -> 200
```

**Nine routes, nine 200s**, and the list is worth reading as the system's shape: two host routes (`/`, `/health`), one
numbers route (`/metrics`), two Resource routes (`/resources`, `/read`), two Prompt routes (`/prompts`, `/prompt`), and two
composed routes (`/plan`, `/ask`). **The pairing is the design** — each primitive gets a discovery route and an act route,
and the last pair composes all three.

### 2. The index describes the service

```bash
curl -s http://127.0.0.1:8080/ | python3 -m json.tool | head -20
```

```json
{
    "host": "task-host",
    "version": "1.0.0",
    "server": "http://127.0.0.1:8081/mcp",
    "model": "offline (no OPENAI_API_KEY)",
    "routes": [
        { "method": "GET", "path": "/", "description": "this index" },
        { "method": "GET", "path": "/health", "description": "readiness, with live capability counts" },
        { "method": "GET", "path": "/resources", "description": "the catalogue: resources and templates" }
```

**`model: "offline (no OPENAI_API_KEY)"`** — the host reporting its own configuration, and the phrase that resolves the
Chapter 16 mystery: the string `"openai"` in the source is a *report*, not an import.

**`server: "http://127.0.0.1:8081/mcp"`** — the index states which server this host dialled, so a reader can tell the two
processes apart and check the pairing without reading `env`.

And the descriptions are sentences — *"readiness, with live capability counts"*, *"the catalogue: resources and
templates"* — which is what makes the index useful to a human rather than merely complete.

### 3. Readiness proven by round trip

```bash
curl -s http://127.0.0.1:8080/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status", d["status"]); print("capabilities", d["capabilities"])'
```

```text
status ready
capabilities {'resources': 9, 'resourceTemplates': 3, 'prompts': 3, 'tools': 4}
```

**Four numbers, and every one came off the wire.** The counts match the server's registration exactly — 9 Resources and 3
templates (Chapter 08's catalogue: 6 concrete plus 3 templates), 3 prompts (Chapter 11) and 4 tools (Chapter 14). So
`/health` answers *"what does the server actually advertise right now?"* rather than *"what did we configure?"*.

The distinction is the whole reason this endpoint calls `tools/list` instead of returning `200 OK`: **a health check that
only proves the HTTP server is up is the kind of check that passes during an outage.** Here, if the MCP session were dead,
the `Promise.all` would reject, the `catch` would fire, and the response would be a 503 with `status: "unready"` — which an
orchestrator can act on.

To see the failure branch, stop the server while the host is running:

```bash
pkill -f 'tsx src/index.ts'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health   # 503
curl -s http://127.0.0.1:8080/health                                   # {"status":"unready","reason":"…"}
```

### 4. Predicting a failure instead of parsing it

```bash
curl -s 'http://127.0.0.1:8080/prompt?name=nope'
```

```json
{"error":{"code":"NOT_FOUND","message":"Unknown prompt: \"nope\".","recovery":"Call GET /prompts to read the available names (plan_day, review_workload, weekly_plan).","retryable":false,"requestId":"764bea7f"}}
```

**A 404, decided by the host from its own memoised menu, with no `prompts/get` call made.** That is Block 9's design
working: the SDK would have reported `InvalidParams` for this name — indistinguishable from a bad argument — so the host
predicts instead of parsing.

And the recovery sentence **names the real menu**, generated from the cached names:

```text
Call GET /prompts to read the available names (plan_day, review_workload, weekly_plan).
```

So a caller who guessed wrong is told exactly what to guess. That is only possible because the host holds its own copy of
the names — and it is a good example of why a host duplicating *some* knowledge is a feature rather than a smell.

Note also the body has **five fields** (`retryable` and `requestId` present), unlike the route-level 404 from Chapter 24.
The difference is the path: this one *throws*, so `errorHandler` builds the response, while a bad URL is answered by the
catch-all `app.use`. Two 404s, two shapes — the inconsistency Chapter 24 documents.

### 5. The composed request

```bash
curl -s 'http://127.0.0.1:8080/plan?hours=4' | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(s["step"], s["controlledBy"], "|", s["primitive"], "|", s["detail"][:110]) for s in d["steps"]]'
```

```text
1 user | prompt | prompts/get plan_day {"availableHours":"4"} → 1 message(s) in 15 ms. The prompt supplies instructions, never facts.
2 application | resource | Selected 2 of 2 candidates via [retrieval]: task://backlog ← retrieval; task://guidelines ← retrieval. Read 2, budgeted to 501 chars.
3 model | tool | No model configured, so the assembled request is echoed instead. The prompt still names list_tasks and the tool is still registered — the model's decision is the only step missing.
```

**Note the strategies: `[retrieval]` only.** This request sent no `x-projects` header, so the session has no project scope and
strategy 2 (`state`) contributes nothing. Add one and it fires:

```bash
curl -s -H 'x-projects: fde' 'http://127.0.0.1:8080/plan?hours=4'
#   → [state, retrieval], 3 candidates, task://projects/fde ← state, 635 chars
```

That is the session Chapter 21's lifecycle run uses — which is why the walkthrough reports
`task://projects/fde ← state` while this bare request does not. **The selection is a function of the session, not just the
message**, which is exactly what the scope translation in `assembleContext` exists to express.

**Three steps, three owners, three primitives** — and each detail sentence teaches its own rule:

| Step | The sentence's lesson |
| :--- | :--- |
| 1 | *"The prompt supplies instructions, never facts."* |
| 2 | *"task://backlog ← retrieval"* — the strategy that chose it, in the output |
| 3 | *"the model's decision is the only step missing"* — honest about the offline gap |

Step 3's sentence is the one to keep. It does not claim the pipeline failed, and it does not pretend a tool was called: it
says the prompt names `list_tasks`, the tool is registered, and **only the model's decision is absent**. That is exactly the
right report for an offline run — the Tool primitive is *wired*, merely unexercised.

### 6. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **Why does `GET /` exist separately from `GET /health`?**
   `/` is the **index** — prose, for a human who has just curled it. `/health` is **readiness** — it calls `tools/list`,
   because *a health check that only proves the HTTP server is up is the kind of check that passes during an outage.*

2. **Why does the health check use `Promise.all` when Chapter 21 used `allSettled`?**
   Because a readiness check wants all-or-nothing semantics — *"partially ready"* is not a state an orchestrator can act
   on — while context assembly wants a degraded answer rather than none.

3. **Why does `/resources` return instances and templates in one response?**
   Because a client needs both to render an "attach context" picker: instances as checkboxes, templates as a text field.
   And they are kept as separate arrays with different address keys (`uri` vs `uriTemplate`) because a template is not
   readable as-is.

4. **What is the security order in `read`, and why is it stronger here than in the selector?**
   *Validate shape → authorise → read.* It is stronger than the ranking path's because **a check that runs after the read
   has already leaked whatever it was checking for** — there the leak is existence, here it would be content.

5. **Why does `read` throw with `decision.code` rather than a fixed class?**
   So 404 and 403 stay distinct: an address that does not exist and one the session may not read need different responses.
   Collapsing both into "no" means a client cannot tell a typo from a permissions problem.

6. **What does the file that never calls a model do about it?**
   It says so in the payload — `modelCalled: false` plus a `note` — because *a caller who confuses the two will build a UI
   that thinks it has an answer when it only has a question.* The distinction is in the data, not only the docs.

7. **Why does the host memoise the prompt menu instead of letting the server reject an unknown name?**
   Because the SDK validates the name itself and reports `InvalidParams`, which is indistinguishable from a malformed
   argument. So the host predicts the failure: *a host that can predict a failure should predict it, rather than parse the
   server's error for it.*

8. **Why does `promptController.get` check the name but not the arguments?**
   Because it **can** check the name (it has the menu) and **cannot** do better than the server on the arguments (the
   schema lives there). *Two validators for one contract is two things to keep in sync.* Check what you can predict;
   delegate what you cannot.

9. **Why do `/plan` and `/ask` share `runPipeline`?**
   Because they differ *only* in whether step 1 is a prompt the user selected or a message they typed. Writing it once is
   what makes that difference visible instead of buried in two near-identical handlers.

10. **Why does the host keep its own copy of the resource catalogue?**
    Because the ACL has to run *before* a read, and asking the server "may I read this?" would be a round trip that answers
    the wrong question — **the server has no session.** The descriptor table is *shared source, not shared state*: the same
    module is called in both processes, so they agree by construction.

11. **What does the `requestConsent` handler in `routes/index.ts` do, and why?**
    It logs `consent.not_implemented` and returns `false`. Denying is the only safe default, and the HTTP host never invokes
    a tool — it reads Resources and renders Prompts — so the handler is unreachable in normal operation. A not-implemented
    path that fails closed and says so.

12. **Why is the shutdown order "stop accepting, then close the MCP session"?**
    Because closing the client first would fail the requests already in flight — *the opposite of graceful.*

---

**[← Chapter 24: Middleware](./24_Middleware.md)** · **[Chapter 26: The Lifecycle Walkthrough →](./26_Lifecycle_Walkthrough.md)**

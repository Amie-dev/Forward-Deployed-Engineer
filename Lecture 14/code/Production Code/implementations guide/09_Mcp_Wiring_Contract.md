# Chapter 09: MCP — The Wiring Contract

> **Chapter goal:** Name the set of things a capability needs, as one interface, so
> that the three primitive registrars take it as an argument instead of importing it.

---

## 9.1 File details

| | |
| :--- | :--- |
| **Path** | `src/mcp/deps.ts` |
| **Layer** | mcp (types only — **no runtime code at all**) |
| **Purpose** | Declare `ServerDeps`: the five collaborators every capability registrar receives |
| **Imports** | `type`-only: `RateLimiter`, `Logger`, `Metrics`, `TaskService` |
| **Exports** | `interface ServerDeps` |
| **Consumed by** | `src/mcp/tools.ts`, `src/mcp/resources.ts`, `src/mcp/server.ts` |
| **Lecture sections** | [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §"Testing" (three of the four layers need no model) |

### Commands

```bash
cd "Lecture 14/code/Production Code"
npm run typecheck
```

> This is the only chapter in the guide whose file has **no runtime behaviour**. It
> compiles away to nothing. Everything it does, it does to the type checker.

---

## 9.2 Full file

```ts
import type { RateLimiter } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { TaskService } from "../services/taskService.js";

/**
 * The wiring contract shared by the three primitive registrars.
 *
 * Everything a capability needs arrives as an argument rather than an import,
 * which is what makes Chapter 08's testing claim concrete: *three of the four
 * test layers need no model at all.* `registerTools(server, deps)` can be
 * exercised against a fake service with no transport, no child process and no
 * LLM anywhere in the picture.
 */
export interface ServerDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly service: TaskService;
  readonly limiter: RateLimiter;
  /** Per-call budget, in milliseconds (Chapter 08 — timeouts). */
  readonly timeoutMs: number;
}
```

## 9.3 Block-by-block explanation

### Block 1 — why a shared type, and not a shared module

The comment answers the design question directly:

> Everything a capability needs arrives as an argument rather than an import.

That sentence is the difference between two architectures:

| | Import the dependency | Receive it as an argument |
| :--- | :--- | :--- |
| **Test setup** | Build a fake `env`, stub the module system | Pass a literal object |
| **Coupling** | `tools.ts` knows how the logger is constructed | `tools.ts` knows only its shape |
| **Swap-ability** | Requires module mocking | One line at the composition root |
| **Failure mode** | A hidden global two callers can disagree about | Impossible — the value is a parameter |

The last row is the one that matters in production. A module-level singleton means two
call sites *can* hold different views of the same dependency (one created before a
config change, one after), and the resulting bug is a nightmare to reproduce. A
parameter cannot drift, because there is one per server instance.

Note what the interface enables, stated in the comment: *"`registerTools(server, deps)`
can be exercised against a fake service with no transport, no child process and no LLM
anywhere in the picture."* That is Chapter 08's testing table made concrete — three of
the four layers (unit, protocol, security) need no model, and this interface is why.

### Block 2 — the five fields, and why each one is here

```ts
export interface ServerDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly service: TaskService;
  readonly limiter: RateLimiter;
  /** Per-call budget, in milliseconds (Chapter 08 — timeouts). */
  readonly timeoutMs: number;
}
```

**`logger`** — for the `tool.call` and `tool.failure` events in `guard()`. Passed as the
`Logger` *interface*, not a concrete logger, so a test can pass a quiet one.

**`metrics`** — for the counters and latency observations in `guard()`.

**`service`** — the business logic. This is the field that makes the testing claim real:
a fake service that throws a `ToolError` on demand exercises the entire error-mapping
path with no store, no data and no model.

**`limiter`** — the rate limiter, shared across all tools. It is a single instance
because the limiter is stateful (one bucket per key, and the keys are tool names).
Passing the `RateLimiter` *class type* rather than a plain function keeps the state
where it belongs — in the instance, not in a closure.

**`timeoutMs`** — a **number**, not an object. This is the smallest field and the most
deliberate one. The alternatives were:

- Pass the whole `env` object — which would give every capability access to
  `MCP_SERVER_VERSION`, the policy switches and the URI scheme, none of which it needs.
- Pass a `{ withTimeout }` helper — which would hide the budget inside a function and
  make it harder to log.

A bare number says exactly what it is: *this is the per-call budget, in milliseconds*.
The doc comment supplies the unit, which is the one thing a bare number cannot convey.

### Block 3 — `readonly`, and what it does and does not guarantee

Every field is `readonly`. That is worth being precise about, because `readonly` on an
interface property is a narrower guarantee than it looks:

- **What it prevents:** `deps.logger = otherLogger` — reassigning the property on an
  object typed as `ServerDeps`.
- **What it does not prevent:** `deps.service.create(...)` — calling methods that mutate
  the service's internal state. `TaskService` has no mutating methods of its own, but the
  store behind it does.

So `readonly` here is a *documentation* guarantee: it says "the wiring is fixed for the
lifetime of the server instance; nothing downstream is expected to swap a collaborator
mid-flight". That is exactly the property you want in a composition root, and it costs
nothing to state.

### Block 4 — `import type`, and why every import is one

```ts
import type { RateLimiter } from "../core/guards.js";
```

All four imports use `import type`. Two consequences:

1. **The imports are erased at compile time.** `deps.ts` emits no `import` statements at
   all, so it cannot introduce a runtime dependency or a load-order problem.
2. **It breaks a would-be cycle at the type level.** `mcp/server.ts` imports `deps.ts`,
   and `deps.ts` imports from `core/` and `services/`. If those were value imports,
   `deps.ts` would join the runtime graph and a future refactor could create a genuine
   cycle. Type-only imports cannot participate in a runtime cycle, because there is no
   runtime edge.

`RateLimiter` is imported as a type even though it is a **class**, and that is the subtle
one. A class is both a type and a value; `import type { RateLimiter }` takes only the
type. The interface needs only the shape (`check(key): { allowed, retryAfterMs }`), so
the type is enough — and `tools.ts`, which actually calls `.check()`, needs no import
because it receives an instance.

### Block 5 — where the wiring actually happens

`ServerDeps` is a contract with no implementation. The implementation is one object
literal in the composition root:

```ts
// src/mcp/server.ts
const deps: ServerDeps = {
  logger,
  metrics,
  service,
  limiter,
  timeoutMs: env.MCP_TOOL_TIMEOUT_MS,
};
```

That is the whole pattern. The three registrars take `deps` and never look further;
`server.ts` is the only file that knows how each collaborator is built. In a larger
system this is where a DI container would go — but with five dependencies, an object
literal is clearer than a framework and type-checks the same.

---

## 9.4 Run / verify

There is nothing to run, but there is something to check: **`deps.ts` must emit no
runtime code.** Compile the project to a scratch directory and read the output:

```bash
npx tsc --outDir /tmp/pc-dist
cat /tmp/pc-dist/mcp/deps.js
```

```text
export {};
```

One line — the empty-module marker, plus a source-map comment. The interface, the four
`import type` statements and the JSDoc all disappeared. That is proof this file's entire
contribution is to the type checker.

For contrast, look at files that *do* have runtime behaviour:

```bash
wc -l /tmp/pc-dist/mcp/deps.js /tmp/pc-dist/mcp/tools.js /tmp/pc-dist/core/logger.js
```

```text
   1 /tmp/pc-dist/mcp/deps.js
 149 /tmp/pc-dist/mcp/tools.js
  77 /tmp/pc-dist/core/logger.js
```

One line versus 149. `deps.ts` is a contract; the other two are machinery.

Then confirm the contract actually binds, by breaking it — temporarily delete
`timeoutMs` from the `deps` literal in `src/mcp/server.ts` and run `npm run typecheck`.
The error names the missing property:

```text
src/mcp/server.ts(48,3): error TS2739: Type '{ logger: Logger; metrics: Metrics; service: TaskService; limiter: RateLimiter; }'
  is missing the following properties from type 'ServerDeps': timeoutMs
```

That is the interface doing its job: the composition root cannot forget a collaborator,
because the compiler will not let it compile. Restore the field afterwards and confirm
with `npm run typecheck`.

Clean up the scratch build:

```bash
rm -rf /tmp/pc-dist
```

---

## 9.5 Checkpoint

1. **Dependencies are injected, not imported.** A capability receives what it needs as an
   argument, so the same registrar runs against real collaborators or fakes.
2. **`ServerDeps` is types only.** Four `import type` statements and an interface — the
   compiled output is literally `export {};`.
3. **`timeoutMs` is a number, not an object.** The smallest possible surface; a capability
   gets the budget it needs and nothing more of the configuration.
4. **The composition root is the only place that knows how the pieces are built.**
   `src/mcp/server.ts` constructs; the registrars consume.
5. **This interface is what makes "three of four test layers need no model" true.** Fake
   the service, pass a quiet logger, and the whole tool path is testable with no
   transport, no child process and no LLM.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 08 — Service: Validated Business Logic](./08_Services_Task_Service.md)

**Next:** [Chapter 10 — MCP: The Tools Primitive](./10_Mcp_Tools.md)

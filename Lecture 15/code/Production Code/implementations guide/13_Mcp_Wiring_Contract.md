# Chapter 13 — MCP: The Wiring Contract

> **53 lines with no logic in them, and they are what makes the testing claim true.** Every capability the
> server exposes receives its dependencies as an *argument* rather than importing them, so
> `registerTools(server, deps)` can be exercised against a fake service with no transport, no child process
> and no model anywhere in the picture.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/mcp/deps.ts` (53 lines) |
| **Layer** | `mcp` — imports **types only**, from every layer below it |
| **Purpose** | Declare the one object the three primitive registrars share, and nothing else. |
| **Exports** | `ServerDeps` (an interface — no runtime value at all) |
| **Lecture sections** | Ch01 §1.6 (assembly), Ch08 §8.1 (the capability provider) |
| **Runs** | Nothing directly — it is exercised by every registration |

---

## Commands

```bash
# there is no runtime to exercise — the file compiles to a 43-byte module marker
npx tsc --outDir /tmp/distcheck && cat /tmp/distcheck/mcp/deps.js

# but its shape is what makes this possible — a real registration, no transport
npm run lifecycle 2>/dev/null | head -3
```

---

## Why a file with no code

The whole file is one interface, and the header states its purpose:

> Everything a capability needs arrives as an argument rather than an import, which is what makes the testing
> claim concrete: `registerTools(server, deps)` can be exercised against a fake service with no transport, no
> child process and no model anywhere in the picture.

That is the dependency-injection argument, and it is worth checking how much it actually buys. `registerTools`
imports the `McpServer` *type* and `ServerDeps` — it does not import `createTaskStore`, `createLogger`,
`createResourceService` or anything else concrete. So a test can write:

```ts
const deps: ServerDeps = { logger: quiet, metrics: counting, tasks: fakeTasks, /* … */ };
const server = new McpServer({ name: "test", version: "0.0.0" });
registerTools(server, deps);
```

— and every tool becomes callable with no I/O. That is only possible because the *contract* is a separate file
from the *assembly*, which is the point of splitting `deps.ts` from `server.ts`.

And Lecture 15 makes this contract do more work than a tool-only server's would, as the header notes:

> Lecture 15 makes this contract do more work than Lecture 14's did, because there are now **three primitives with
> three different owners** — and the *only* thing that makes that legible is that all three receive the same
> object and read different fields out of it.

That is the observation worth dwelling on. Three registrars, three primitives, three different control models —
and one shared argument object. The difference between them is visible in *which fields each reads*, not in three
different wiring styles. A reader comparing `registerTools` with `registerPrompts` sees the same `deps` parameter
and can therefore see the difference in behaviour rather than the difference in plumbing.

---

## `src/mcp/deps.ts` — the full file

```ts
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { RateLimiter } from "../core/guards.js";
import type { ResourceCatalogue } from "../domain/resourceCatalogue.js";
import type { PromptService } from "../services/promptService.js";
import type { ResourceService } from "../services/resourceService.js";
import type { TaskService } from "../services/taskService.js";

/**
 * The wiring contract shared by the three primitive registrars.
 *
 * Everything a capability needs arrives as an argument rather than an import,
 * which is what makes the testing claim concrete: `registerTools(server, deps)`
 * can be exercised against a fake service with no transport, no child process
 * and no model anywhere in the picture.
 *
 * Lecture 15 makes this contract do more work than Lecture 14's did, because
 * there are now three primitives with three different owners — and the *only*
 * thing that makes that legible is that all three receive the same object and
 * read different fields out of it.
 */
export interface ServerDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;

  /** The write side — reached by Tools. */
  readonly tasks: TaskService;
  /** The read side — reached by Resources. */
  readonly resources: ResourceService;
  /** The templates — reached by Prompts, and by nothing else. */
  readonly prompts: PromptService;
  /** The descriptor table, so the resource registrar can register declaratively. */
  readonly catalogue: ResourceCatalogue;

  /** Namespaced per primitive, so one noisy capability cannot starve the rest. */
  readonly limiter: RateLimiter;

  /**
   * Two budgets, not one: `prompts/get` is a local template render while
   * `resources/read` may reach a backend (Notes Ch07 §"Streaming, timeouts and
   * cancellation").
   */
  readonly toolTimeoutMs: number;
  readonly resourceTimeoutMs: number;

  /**
   * Notes Ch03 §3.5 — the URI schemes this server will resolve.
   *
   * Checked *before* a handler runs, which is what stops a template from
   * becoming an enumeration oracle over a scheme nobody meant to expose.
   */
  readonly allowedSchemes: ReadonlySet<string>;
}
```

### Block-by-block

**Block 1 — the imports (lines 1–7).**

```ts
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { RateLimiter } from "../core/guards.js";
import type { ResourceCatalogue } from "../domain/resourceCatalogue.js";
import type { PromptService } from "../services/promptService.js";
import type { ResourceService } from "../services/resourceService.js";
import type { TaskService } from "../services/taskService.js";
```

**Seven imports, every one of them `import type`.** That is not a style preference — it is what makes this file
vanish at compile time. With `import type`, TypeScript erases the import entirely, and an interface erases too, so
`deps.ts` compiles down to a **43-byte module marker**:

```bash
npx tsc --outDir /tmp/distcheck
cat /tmp/distcheck/mcp/deps.js
```

```js
export {};
//# sourceMappingURL=deps.js.map
```

```bash
wc -c /tmp/distcheck/mcp/deps.js /tmp/distcheck/mcp/tools.js
#   43 /tmp/distcheck/mcp/deps.js
# 8611 /tmp/distcheck/mcp/tools.js
```

Forty-three bytes against `tools.js`'s 8,611 — and all 43 are the ESM module marker, which exists only because the
file is a module. There is no runtime code, no circular-import risk, and no bundler entry.

That matters concretely here, because this file imports from `core`, `domain` and `services` — three layers — and
is in turn imported by `mcp/tools.ts`, `mcp/resources.ts` and `mcp/server.ts`. If these were value imports, that
would be a genuinely tangled graph. As type imports it is a purely compile-time relationship: the interface
describes a shape, and the shape is enforced at the call site in `server.ts`.

Note also the dependency direction. `deps.ts` imports from *below* it (Chapter 01's rule) — `core`, `domain`,
`services` — and nothing below imports from `mcp/`. So the contract sits at the boundary and points inward.

**Block 2 — the two observability fields (lines 22–24).**

```ts
export interface ServerDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
```

Every field is `readonly`, and the consequence is worth naming: **one `deps` object can be shared by every
per-request server instance without any risk of two requests racing on it.** That is exactly what
`mcp/server.ts` does (Chapter 17) — the object is built once at module scope and handed to every `createServer()`
call. `readonly` is what makes that safe rather than merely conventional: a registrar cannot reassign
`deps.tasks` and affect another request.

Note what is *not* `readonly` — the objects *inside* these fields. `deps.tasks` is a `TaskService` whose methods
mutate the store. Immutability of the reference, mutability of the referent: the shape a dependency-injection
container always has.

**Block 3 — the four service fields (lines 26–33).**

```ts
  /** The write side — reached by Tools. */
  readonly tasks: TaskService;
  /** The read side — reached by Resources. */
  readonly resources: ResourceService;
  /** The templates — reached by Prompts, and by nothing else. */
  readonly prompts: PromptService;
  /** The descriptor table, so the resource registrar can register declaratively. */
  readonly catalogue: ResourceCatalogue;
```

Four fields with four comments, and reading them as a group is the clearest statement of the lecture's control
model anywhere in the codebase:

| Field | Comment | Read by |
| :--- | :--- | :--- |
| `tasks` | *The write side — reached by Tools.* | `mcp/tools.ts` |
| `resources` | *The read side — reached by Resources.* | `mcp/resources.ts` |
| `prompts` | *The templates — reached by Prompts, and by nothing else.* | `mcp/prompts.ts` |
| `catalogue` | *The descriptor table, so the resource registrar can register declaratively.* | `mcp/resources.ts` |

**Each service has exactly one reader.** `tasks` is touched only by the tool registrar; `prompts` only by the
prompt registrar. That is not enforced by the compiler, and it is a real architectural property: it means a change
to how tools mutate state cannot affect the Resource path, and it means the three primitives are genuinely
independent rather than nominally so.

The one shared field is `catalogue`, read by `resources` (for declarative registration) — and, importantly, *not*
by `tools`. The tool registrar does not consult the catalogue, even though `list_tasks` returns a Resource's body;
it calls `deps.resources.read(BACKLOG_URI)` instead. So the tool layer depends on the *resource service*, not on
the catalogue, which keeps the descriptor table out of the write path entirely.

Note also that `catalogue` is present at all, and why: without it, `mcp/resources.ts` would have to hard-code six
registration blocks instead of looping over descriptors. The field exists so registration can be **declarative**
(Chapter 15) — the same reason it is in the contract rather than passed separately.

**Block 4 — the rate limiter, and why it is one (lines 35–36).**

```ts
  /** Namespaced per primitive, so one noisy capability cannot starve the rest. */
  readonly limiter: RateLimiter;
```

One limiter instance, and the comment explains why that is not a conflict with namespacing: the *keys* are
namespaced (`tool:list_tasks`, `resource:read`), so a single object holds several independent windows. That is the
right shape — one limiter, many keys — because a per-primitive limiter object would mean three instances sharing
no configuration and needing three injections.

And it must be **one** instance for the limit to mean anything, which is the defect Chapter 17 documents: a
limiter constructed per request resets its window per request, and a rate limiter that resets per request does not
rate limit. Sharing it is what makes Chapter 06's sliding window observable at all.

**Block 5 — the two timeouts (lines 38–44).**

```ts
  /**
   * Two budgets, not one: `prompts/get` is a local template render while
   * `resources/read` may reach a backend (Notes Ch07 §"Streaming, timeouts and
   * cancellation").
   */
  readonly toolTimeoutMs: number;
  readonly resourceTimeoutMs: number;
```

Two numbers rather than one, and the comment states the distinction: a `prompts/get` is a local template render
(fast, predictable) while a `resources/read` may reach a backend (slower, unpredictable). The defaults reflect it —
`5000` ms for tools, `2000` ms for resources (Chapter 02) — and the *resource* budget is the tighter one, because a
read is a lookup rather than a computation.

Note that prompts do not appear here, and there is no `promptTimeoutMs`. A prompt render is a pure function of its
arguments (Chapter 11) — there is nothing that could hang, so there is no budget to set. **The absence of a
parameter is documentation**: the shape of `ServerDeps` says which primitives can be slow.

**Block 6 — the scheme allowlist (lines 46–52).**

```ts
  /**
   * Notes Ch03 §3.5 — the URI schemes this server will resolve.
   *
   * Checked *before* a handler runs, which is what stops a template from
   * becoming an enumeration oracle over a scheme nobody meant to expose.
   */
  readonly allowedSchemes: ReadonlySet<string>;
```

The last field, and the only one whose type is a container rather than a service. `ReadonlySet<string>` — a set,
because membership is the only operation, and `Readonly` because a registrar must not be able to add a scheme at
runtime.

*Checked before a handler runs* is the security property, and it is worth being precise about where "before" is.
The check lives in `readThrough` in `mcp/resources.ts` (Chapter 15), at the very top of the resource read path — so
a URI outside the allowlist never reaches a renderer. The doc comment names the threat: *a template from becoming
an enumeration oracle over a scheme nobody meant to expose.*

And one honest limitation, documented in the main README: this is **defence in depth, not the first gate.** The
SDK's own router rejects an unknown URI before any handler runs, so `file:///etc/passwd` never reaches this check.
What the allowlist still stops is a *registered* descriptor being served under a scheme the deployment did not
intend — a case the SDK cannot know about, because it has no opinion on which schemes are appropriate for this
application.

---

## Run / verify

### 1. The file really does vanish

The claim is measurable, so measure it. Compile the project and look at what `deps.ts` produced:

```bash
npx tsc --outDir /tmp/distcheck
ls -la /tmp/distcheck/mcp/
```

```text
-rw-rw-r-- 1 aminul aminul 2252 deps.d.ts
-rw-rw-r-- 1 aminul aminul   43 deps.js
-rw-rw-r-- 1 aminul aminul  192 deps.js.map
-rw-rw-r-- 1 aminul aminul 1325 prompts.d.ts
-rw-rw-r-- 1 aminul aminul 5354 prompts.js
...
-rw-rw-r-- 1 aminul aminul 8611 tools.js
```

And the 43 bytes:

```bash
cat /tmp/distcheck/mcp/deps.js
```

```js
export {};
//# sourceMappingURL=deps.js.map
```

```bash
wc -c /tmp/distcheck/mcp/deps.js /tmp/distcheck/mcp/tools.js
#   43 /tmp/distcheck/mcp/deps.js
# 8611 /tmp/distcheck/mcp/tools.js
```

**43 bytes against 8,611** — a 200× difference, and all 43 bytes are the ESM module marker. The seven `import type`
statements and the interface are gone completely. Note `deps.d.ts` is 2,252 bytes: the *type* survives, which is
what consumers need, and the *code* does not exist, which is what the graph needs.

### 2. The contract is exercised by every registration

The file has no runtime behaviour of its own, so the way to verify it is to verify that the thing it enables works.
`npm run lifecycle` constructs a real `deps` object and calls all three registrars through it:

```bash
npm run lifecycle 2>/dev/null | head -3
```

```text
1. handshake   -> capabilities are negotiated, not guessed
   server       task-mcp-server v1.0.0
   capabilities completions, logging, prompts, resources, tools
```

Four primitives registered — `tools`, `resources`, `prompts` and `completions` — from three registrars, all taking
the same `deps`. That is the header's claim (*all three receive the same object and read different fields out of
it*) observed from outside.

### 3. The scheme allowlist is auditable without reading code

`allowedSchemes` arrives from config, and the server logs it at boot — which is the point of putting it in the
contract rather than hard-coding it in the resource registrar:

```bash
npm run lifecycle 2>&1 >/dev/null | grep server.ready
```

```json
{"ts":"…","level":"info","event":"server.ready","server":"task-mcp-server","version":"1.0.0","resources":6,"templates":3,"prompts":3,"allowedSchemes":["task","user"],"toolTimeoutMs":5000,"resourceTimeoutMs":2000,"maxResourcesPerRequest":3,"maxContextChars":40000,"resourceCacheTtlMs":30000}
```

One line containing every `ServerDeps` field that came from configuration: `allowedSchemes`, `toolTimeoutMs`,
`resourceTimeoutMs`. An operator can read the running policy without reading `mcp/deps.ts` — which is what
*auditable without reading code* means in practice.

And to see the allowlist bind, remove a scheme from `.env` and watch a read be refused:

```bash
MCP_ALLOWED_RESOURCE_SCHEMES=task npx tsx src/index.ts &
# then read user://123/profile — FORBIDDEN, "Resource scheme \"user\" is not served here."
```

### 4. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

The `readonly` markers are enforced by the compiler: a registrar that tried `deps.tasks = fakeTasks` would fail to
compile. That is what makes it safe for `mcp/server.ts` to build one `deps` at module scope and hand it to every
per-request server instance (Chapter 17).

---

## Checkpoint

1. **Why is the wiring contract a separate file from the composition root?**
   So a test can construct a `deps` object from fakes and call a registrar with no transport, no child process and no
   model. `deps.ts` is the *shape*; `server.ts` is the *assembly*. Separating them is what makes the shape reusable.

2. **Why are all seven imports `import type`?**
   So the file compiles to nothing — a 43-byte module marker — instead of creating a runtime module that imports
   from three layers and is imported by three more. The relationship is compile-time only.

3. **Why does each service field have exactly one reader?**
   `tasks` → tools, `resources` → the resource registrar, `prompts` → the prompt registrar. It means the three
   primitives are genuinely independent, so a change to the write path cannot affect the read path.

4. **Why is there one rate limiter rather than one per primitive?**
   Because the *keys* are namespaced (`tool:list_tasks`, `resource:read`), so one object holds independent windows.
   And it must be one instance: a limiter constructed per request resets its window per request, and therefore does
   not limit anything.

5. **Why two timeouts, and why is there no `promptTimeoutMs`?**
   A `resources/read` may reach a backend while a `tool` call may compute; a `prompts/get` is a local template
   render — a pure function of its arguments — so there is nothing that could hang. The absence of the parameter is
   the documentation.

6. **What does `allowedSchemes` buy, given the SDK already rejects unknown URIs?**
   It stops a *registered* descriptor being served under a scheme this deployment did not intend — a case the SDK
   cannot know about, because it has no opinion on which schemes are appropriate here. It is defence in depth, not
   the first gate.

---

**[← Chapter 12: The Selection Service](./12_Service_Selection_Service.md)** · **[Chapter 14: The Tools Primitive →](./14_Mcp_Tools.md)**

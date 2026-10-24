# Chapter 23 — Host: The Wiring Contract

> **The mirror image of `mcp/deps.ts`.** The *server* hands its three primitive registrars one object; the *host* hands
> its four controllers one object. In both cases the object is the only thing a layer receives — which is what makes
> every layer constructible in a test with no transport, no child process and no model.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/host/deps.ts` (43 lines) |
| **Layer** | `host` — imports **types only**, from `core`, `services` and its own directory |
| **Purpose** | Declare the one object the four host controllers share, and nothing else. |
| **Exports** | `HostDeps` (an interface — no runtime value) |
| **Lecture sections** | Ch04 (host, client and server), Ch08 §8.2 |
| **Runs** | Nothing directly — it is exercised by every controller |

---

## Commands

```bash
# the same check as Chapter 13: the file compiles to a module marker
npx tsc --outDir /tmp/distcheck && wc -c /tmp/distcheck/host/deps.js

# and its shape is what makes a controller constructible with no HTTP server
npm run host
```

---

## `src/host/deps.ts` — the full file

```ts
import type { ContextBudget } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { SelectionService } from "../services/selectionService.js";
import type { AuditLog } from "./audit.js";
import type { McpClient } from "./client.js";
import type { HostPolicy } from "./policy.js";

/**
 * The wiring contract for the host half of the application.
 *
 * The mirror image of `mcp/deps.ts`, and the parallel is deliberate: the *server*
 * hands its three primitive registrars one object, and the *host* hands its four
 * controllers one object. In both cases the object is the only thing a layer
 * receives, which is what makes every layer constructible in a test with no
 * transport, no child process and no model.
 *
 * The controllers never import `client.ts`, `policy.ts` or `selectionService.ts`
 * directly. They receive this, which is why swapping the Streamable HTTP client
 * for an in-process one — or a real consent dialog for the scripted one — is a
 * change to `routes/index.ts` and nothing else.
 */
export interface HostDeps {
  /** The only door to the MCP server. */
  readonly client: McpClient;
  /** Consent, tool tiers, the resource ACL and the prompt allowlist. */
  readonly policy: HostPolicy;
  /** The five selection strategies. */
  readonly selection: SelectionService;
  /** The three caps that keep a prompt from eating its own budget. */
  readonly budget: ContextBudget;
  /** The record of what was decided, with hashed arguments. */
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly metrics: Metrics;

  /** The knobs the controllers need, gathered so they are read in one place. */
  readonly limits: {
    maxResourcesPerRequest: number;
    maxResourceChars: number;
    maxContextChars: number;
  };
}
```

### Block-by-block

**Block 1 — the imports, all type-only (lines 1–7).**

```ts
import type { ContextBudget } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";
import type { SelectionService } from "../services/selectionService.js";
import type { AuditLog } from "./audit.js";
import type { McpClient } from "./client.js";
import type { HostPolicy } from "./policy.js";
```

Seven imports, every one `import type` — the same discipline as `mcp/deps.ts` (Chapter 13), and the same consequence:
the file compiles to a module marker with no runtime code.

Note the dependency direction, which is worth comparing with the server's contract:

| Contract | Imports from |
| :--- | :--- |
| `mcp/deps.ts` | `core`, `domain`, `services` |
| `host/deps.ts` | `core`, `services`, and **three files in its own directory** |

The host's contract is the more interesting graph, because it imports from `./client.js`, `./policy.js` and `./audit.js` —
its own siblings. That is the host's structure showing through: the client, the policy, the selection engine, the budget and
the audit log are the five things a controller needs, and they are peers rather than layers. `deps.ts` is the one file that
knows they all exist.

And note what is *not* imported: nothing from `mcp/`. The host has no compile-time knowledge of the server at all — the
only connection is `McpClient`, which is an interface over a transport.

**Block 2 — the header, and the parallel (lines 9–22).**

> The mirror image of `mcp/deps.ts`, and the parallel is deliberate: the *server* hands its three primitive registrars one
> object, and the *host* hands its four controllers one object. In both cases the object is the only thing a layer
> receives, which is what makes every layer constructible in a test with no transport, no child process and no model.

**Three registrars and four controllers.** That is the whole application in one sentence: the server side has three
primitives to register, and the host side has four surfaces to serve.

> The controllers never import `client.ts`, `policy.ts` or `selectionService.ts` directly. They receive this, which is why
> **swapping the Streamable HTTP client for an in-process one — or a real consent dialog for the scripted one — is a change
> to `routes/index.ts` and nothing else.**

That second clause is the concrete payoff, and it is testable by inspection: no file in `src/controllers/` imports
`client.js` or `policy.js`. They take `HostDeps` and read fields off it. So the *composition* is in one place
(`routes/index.ts`) and the *behaviour* is in the controllers.
One qualification, verified in "Run / verify" below: two controllers **do** import one symbol from `client.ts` —
`textOf`, the pure content-block extractor. That is a different thing from importing the client: `textOf` is a stateless
function with no dependencies to inject, so importing it couples nothing to the transport. The *client object* still
arrives through `deps`.



**Block 3 — the five collaborators (lines 24–35).**

```ts
export interface HostDeps {
  /** The only door to the MCP server. */
  readonly client: McpClient;
  /** Consent, tool tiers, the resource ACL and the prompt allowlist. */
  readonly policy: HostPolicy;
  /** The five selection strategies. */
  readonly selection: SelectionService;
  /** The three caps that keep a prompt from eating its own budget. */
  readonly budget: ContextBudget;
  /** The record of what was decided, with hashed arguments. */
  readonly audit: AuditLog;
```

Five fields, five one-line descriptions, and reading them together is the host's architecture:

| Field | Its one-line description | Which chapter |
| :--- | :--- | :--- |
| `client` | *The only door to the MCP server* | 19 |
| `policy` | *Consent, tool tiers, the resource ACL and the prompt allowlist* | 20 |
| `selection` | *The five selection strategies* | 12 |
| `budget` | *The three caps that keep a prompt from eating its own budget* | 06 |
| `audit` | *The record of what was decided, with hashed arguments* | 22 |

**Five collaborators, and only one of them talks to the network** — `client`. The other four are pure logic over data,
which is why the host's controllers can be tested without a server.

Every field is `readonly`, for the same reason as `ServerDeps` (Chapter 13): one `deps` object is built once in
`routes/index.ts` and shared by every request. `readonly` means a controller cannot reassign `deps.policy` and affect a
concurrent request, so the sharing is obviously correct rather than merely conventional.

**Block 4 — the observability pair (lines 34–35).**

```ts
  readonly logger: Logger;
  readonly metrics: Metrics;
```

Same two fields as `ServerDeps`, and they serve the same purpose: the controllers log through `deps.logger` and count
through `deps.metrics`, so one run's log stream and one `/metrics` response describe the whole request path.

The symmetry is worth noticing: **both contracts carry the same observability pair plus their own domain objects.** That
is what makes the two processes' logs comparable — the same logger shape, the same metric names by convention, and a
`"host":"task-host"` / `"server":"task-mcp-server"` binding distinguishing them (Chapter 03).

**Block 5 — `limits`, gathered rather than scattered (lines 37–42).**

```ts
  /** The knobs the controllers need, gathered so they are read in one place. */
  readonly limits: {
    maxResourcesPerRequest: number;
    maxResourceChars: number;
    maxContextChars: number;
  };
}
```

**A nested object rather than three flat fields**, and the comment states the reason: *gathered so they are read in one
place.* The three caps come from `config/env.ts` (Chapter 02), and a controller that needed them would otherwise read
`env.MCP_MAX_CONTEXT_CHARS` directly — spreading the config dependency across the controller layer.

By gathering them here, the controllers read `deps.limits.maxContextChars`, and the config is touched in exactly one
place: `routes/index.ts`, the composition root.

Note the three names are **shorter** than the env var names — `maxResourcesPerRequest` rather than
`MCP_MAX_RESOURCES_PER_REQUEST`. That is a deliberate renaming at the boundary: inside the code, `MCP_` prefixes and
shouting case are noise, and the mapping happens once where the config is read. Same pattern as `Session.actor` →
`SelectionScope.userId` in Chapter 21.

And these three are the *same* numbers `assembleContext` uses for its budget (Chapter 21), passed separately because
`assembleContext` takes its dependencies inline rather than taking `HostDeps`. That is the one place the two conventions
meet — and it is a small inconsistency rather than a problem: `assembleContext` is called by two paths (the walkthrough and
the plan controller), one of which does not build a `HostDeps` at all.

---

## Run / verify

### 1. The file really is types-only

```bash
npx tsc --outDir /tmp/distcheck
wc -c /tmp/distcheck/host/deps.js /tmp/distcheck/mcp/deps.js /tmp/distcheck/host/client.js
```

```text
  43 /tmp/distcheck/host/deps.js
  43 /tmp/distcheck/mcp/deps.js
3547 /tmp/distcheck/host/client.js
```

**43 bytes — identical to `mcp/deps.ts`** — while `client.js` is 3,547. Both contracts are the same size because both are
the same thing: an interface plus type-only imports, which TypeScript erases entirely. The 43 bytes are the ESM module
marker.

That symmetry is the visible form of the header's claim: two contracts, one shape, no runtime behaviour in either.

### 2. The controllers do not import their collaborators

The claim that composition lives in one place is checkable:

```bash
grep -rn 'host/policy\|host/audit\|selectionService' src/controllers/
grep -rn 'host/client' src/controllers/
```

```text
(nothing — no controller imports the policy, the audit log or the selection engine)

src/controllers/planController.ts:4:   import { textOf } from "../host/client.js";
src/controllers/promptController.ts:4: import { textOf } from "../host/client.js";
```

So every controller receives its collaborators through `HostDeps` and reads fields off it. That is what makes swapping
the client — for an in-process transport, or for a stub in a test — a change to `routes/index.ts` and nothing else.
**So the accurate claim is narrower than \"no imports\", and it is the right one.** Two controllers import `textOf` —
the pure extractor from Chapter 19 — and that couples nothing, because a stateless function has no collaborators to
receive. What matters is that no controller imports the **policy**, the **audit log** or the **selection engine**, and
none constructs a client. Those are the things whose swapping would otherwise ripple, and they all arrive through
`HostDeps`.



### 3. The host composes the object once, and every request shares it

```bash
npm run host
```

```json
{"ts":"…","level":"info","event":"host.listening","host":"task-host","url":"http://127.0.0.1:8080","server":"http://127.0.0.1:8081/mcp","model":"offline"}
```

One line at boot, and the `host.listening` payload reports what the composition produced: the URL it bound, the server it
dialled, and the model state. Note **`host: "task-host"`** on every line from this process — the binding from
`routes/index.ts`'s logger — so a stream containing both processes is attributable.

Because `deps` is built once in `createHost()` and shared by all requests, one `McpClient` session serves every HTTP
request. That is the *opposite* of the server's per-request factory (Chapter 17), and it is correct here: the host's
session is a long-lived connection it owns, while the server's per-request instances are a property of stateless serving.

### 4. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **What is the parallel between `mcp/deps.ts` and `host/deps.ts`?**
   Both are types-only contracts that are the *only* thing their layer receives: the server hands three registrars one
   object, the host hands four controllers one object. Both compile to a 43-byte module marker.

2. **Why do the controllers not import `client.ts` or `policy.ts`?**
   Because they receive `HostDeps`. That is what makes swapping the transport client, or the consent handler, a change to
   `routes/index.ts` and nothing else — composition in one place, behaviour in the controllers.

3. **Which of the five collaborators talks to the network?**
   Only `client`. The other four — `policy`, `selection`, `budget`, `audit` — are pure logic over data, which is why the
   controllers can be tested without a server.

4. **Why is `limits` a nested object rather than three flat fields?**
   So the three config caps are read in one place. Controllers read `deps.limits.maxContextChars` rather than
   `env.MCP_MAX_CONTEXT_CHARS`, keeping the config dependency inside the composition root.

5. **Why are the `limits` field names shorter than the env var names?**
   A deliberate rename at the boundary: `MCP_` prefixes and shouting case are noise inside the code, and the mapping
   happens once where the config is read.

6. **Why is it safe for every request to share one `deps` object?**
   Because every field is `readonly`, so a controller cannot reassign a collaborator and affect a concurrent request —
   the same guarantee `ServerDeps` provides.

7. **Why does the host build `deps` once while the server builds its protocol object per request?**
   Because the host's MCP session is a long-lived connection it owns, while the server's per-request instances are a
   property of the SDK's stateless serving mode. Same object shape, opposite lifetimes — and each is correct for its side.

---

**[← Chapter 22: The Model Step & The Audit Trail](./22_Host_Model_and_Audit.md)** · **[Chapter 24: Middleware →](./24_Middleware.md)**

# Chapter 15 — MCP: The Resources Primitive

> **Resources are the primitive where the APPLICATION holds the trigger.** A Resource is *know*, not *do*: the
> application — never the model — decides to read it, the content is read-only, and **the URI is the identity**.
> Reading a resource executes nothing, which is exactly why a resource is the right shape for a policy document
> and the wrong shape for an operation.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/mcp/resources.ts` (244 lines) |
| **Layer** | `mcp` |
| **Purpose** | Register all six Resources **declaratively** by looping the descriptor table, with per-template `list` and `complete` hooks, and refuse a non-allow-listed scheme before any renderer runs. |
| **Exports** | `registerResources()` |
| **Lecture sections** | Ch03 §3.1/3.9, Ch04 §4.1–4.7, Ch04 §"Validate and constrain dynamic URIs", Ch04 §"Authorisation and validation live in the handler" |
| **Runs** | `npm run lifecycle` steps 4, 5, 6 |

---

## Commands

```bash
# the three shapes, all through one verb
npm run lifecycle 2>/dev/null | sed -n '/^5\./,/^7\./p'

# a scheme the deployment does not serve
curl -s 'http://127.0.0.1:8080/read?uri=file:///etc/passwd'
```

---

## Declarative registration

The header states the design in one paragraph:

> The registrations below are **declarative**: the loop walks the descriptor table and registers whatever it finds,
> rather than a human writing out six near-identical blocks. That is the production form of Chapter 04's claim that
> registration is declarative and automatic — and it is why **adding a Resource means editing one table, not two
> files.**

*Adding a Resource means editing one table* is the payoff, and it is worth being precise about the chain. To add a
Resource you:

1. add a descriptor to `RESOURCE_DESCRIPTORS` (Chapter 08), and
2. add a renderer case to `resourceService.ts` (Chapter 10).

And that is all — because the boot-time invariant (Chapter 10) *requires* both, the registrar picks it up
automatically, and `resources/list` advertises it without a third edit. The registrar contains no knowledge of the
six specific Resources; it contains a loop.

---

## `src/mcp/resources.ts` — the full file

```ts
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { MIME } from "../config/constants.js";
import { ResourceError, toAppError } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import type { ResourceDescriptor } from "../domain/resourceCatalogue.js";
import type { ServerDeps } from "./deps.js";
import { toProtocolError } from "./protocol.js";

/**
 * Notes Ch03 and Ch04 — **The Resources Primitive**, where the **application**
 * holds the trigger.
 *
 * A Resource is *know*, not *do*: the application — never the model — decides to
 * read it, the content is read-only, and **the URI is the identity**. Reading a
 * resource executes nothing, which is exactly why a resource is the right shape
 * for a policy document and the wrong shape for an operation.
 *
 * The registrations below are **declarative**: the loop walks the descriptor
 * table and registers whatever it finds, rather than a human writing out six
 * near-identical blocks. That is the production form of Chapter 04's claim that
 * registration is declarative and automatic — and it is why adding a Resource
 * means editing one table, not two files.
 *
 * All three shapes from Chapter 04 are here, and the difference between them is
 * the lesson:
 *
 *   STATIC     one address, fixed content
 *   DYNAMIC    one address, content recomputed from live state
 *   TEMPLATE   a *family* of addresses — `task://projects/{projectId}` — whose
 *              instances are computed at `resources/list` time
 */

/**
 * The resource path's equivalent of a tool's `guard`.
 *
 * It exists because a resource failure is a **protocol error**, not a result
 * (Notes Ch03 §3.9): nothing executed, no model is waiting on a recovery
 * sentence, and there is no `isError` channel to carry one. So this wrapper's job
 * is the opposite of the tool guard's — it must make the failure *loud on the
 * wire* rather than friendly in the context.
 *
 * The scheme check happens **before** the read, and that ordering is the security
 * property: a URI outside the allowlist never reaches a renderer, so a template
 * cannot become an enumeration oracle over a scheme nobody meant to expose
 * (Notes Ch04 §"Validate and constrain dynamic URIs").
 */
async function readThrough(deps: ServerDeps, uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const scheme = uri.slice(0, uri.indexOf(":"));

  if (!deps.allowedSchemes.has(scheme)) {
    deps.metrics.count("resource.refused.scheme");
    deps.logger.warn("resource.refused", { uri, reason: "scheme not allow-listed", scheme });

    throw toProtocolError(
      new ResourceError(
        "FORBIDDEN",
        `Resource scheme "${scheme}" is not served here.`,
        `Use one of the allow-listed schemes: ${[...deps.allowedSchemes].join(", ")}.`,
      ),
    );
  }

  try {
    const read = await withTimeout(() => deps.resources.read(uri), deps.resourceTimeoutMs, uri, "resource");

    deps.metrics.count("resource.ok");
    deps.metrics.count(`resource.read.${read.descriptor.name}`);
    deps.metrics.count(`resource.source.${read.source}`);
    deps.metrics.observe("resource.chars", read.chars);
    deps.logger.info("resource.read", {
      uri,
      name: read.descriptor.name,
      kind: read.descriptor.kind,
      source: read.source,
      chars: read.chars,
    });

    return { contents: [{ uri: read.uri, mimeType: read.mimeType, text: read.text }] };
  } catch (error) {
    const failure = toAppError("resource", error, uri);

    deps.metrics.count("resource.error");
    deps.metrics.count(`resource.error.${failure.code}`);
    deps.logger.warn("resource.failure", { uri, code: failure.code, message: failure.message });

    /**
     * The failure keeps its **class** on the way out, and that is what makes the
     * answer useful.
     *
     * A missing resource becomes JSON-RPC `ResourceNotFound` (-32002) — the same
     * code the SDK's own `ResourceNotFoundError` produces, which is why this
     * module does not special-case it. A malformed template variable becomes
     * `InvalidParams` (-32602). Both reach the host as a *protocol error*, which
     * is the correct shape: nothing executed, so there is no `isError` channel
     * and no model waiting on a recovery sentence (Notes Ch03 §3.9).
     */
    throw toProtocolError(failure);
  }
}

/** The metadata every registration shares — four fields, written once. */
function metadataOf(descriptor: ResourceDescriptor) {
  return {
    title: descriptor.title,
    description: descriptor.description,
    mimeType: descriptor.mimeType,
  };
}

export function registerResources(server: McpServer, deps: ServerDeps): void {
  for (const descriptor of deps.catalogue.descriptors()) {
    if (descriptor.kind === "template") {
      registerTemplate(server, deps, descriptor);
    } else {
      registerFixed(server, deps, descriptor);
    }
  }
}

/**
 * STATIC and DYNAMIC share one registration, because the only difference between
 * them is whether the renderer reads live state — and that is
 * `resourceService`'s business, not the protocol layer's.
 *
 * The protocol layer's job is the three fields a client needs and nothing more:
 * where it lives, what it is called, and what the bytes are.
 */
function registerFixed(server: McpServer, deps: ServerDeps, descriptor: ResourceDescriptor): void {
  server.registerResource(
    descriptor.name,
    descriptor.uri,
    metadataOf(descriptor),
    // `resources/read` returns an *array* of contents. Text resources use `text`;
    // a PDF or an image would use a base64 `blob` instead.
    async (uri) => readThrough(deps, uri.href),
  );
}

/**
 * The two optional template hooks, typed explicitly.
 *
 * The annotations are not decoration: without them TypeScript widens each
 * `switch` branch into a union whose absent keys are typed `undefined`, which
 * cannot satisfy the SDK's index-signature contract. Naming the shape is both
 * the fix and the documentation.
 */
type ResourceEntry = { uri: string; name: string; title?: string; mimeType?: string };
type ListInstances = () => Promise<{ resources: ResourceEntry[] }>;
type Completions = Record<string, () => string[]>;

/**
 * `resources/list` for a template's instances.
 *
 * Computing them from live state rather than hardcoding them is the whole point:
 * the catalogue a client sees is derived from the same source the tools mutate,
 * so it cannot go stale.
 *
 * Note which template is **absent**. `user://{userId}/profile` deliberately has
 * no `list`, because enumerating every user's profile is an enumeration oracle —
 * the exact failure mode Chapter 04 warns about. A client may read a profile it
 * already has the id for; it may not ask for the set of all of them.
 */
function instancesFor(descriptor: ResourceDescriptor, deps: ServerDeps): ListInstances | undefined {
  switch (descriptor.name) {
    case "task":
      return async () => ({
        resources: deps.tasks.list().map((task) => ({
          uri: `task://tasks/${task.id}`,
          name: `task-${task.id}`,
          title: task.title,
          mimeType: MIME.json,
        })),
      });

    case "project":
      return async () => ({
        resources: deps.tasks.stats().projects.map((project) => ({
          uri: `task://projects/${project}`,
          name: `project-${project}`,
          title: `Project ${project}`,
          mimeType: MIME.text,
        })),
      });

    default:
      return undefined;
  }
}

/**
 * `completion/complete` for a template's variables, so a host can offer
 * suggestions while the user types a URI instead of making them guess.
 *
 * `user-profile` has no completions for the same reason it has no `list`: the
 * server has no session, so it cannot know whose id is being typed, and offering
 * the full set would be the oracle again by another route.
 */
function completionsFor(descriptor: ResourceDescriptor, deps: ServerDeps): Completions | undefined {
  switch (descriptor.name) {
    case "task":
      return { taskId: () => deps.tasks.list().map((task) => String(task.id)) };

    case "project":
      return { projectId: () => [...deps.tasks.stats().projects] };

    default:
      return undefined;
  }
}

function registerTemplate(server: McpServer, deps: ServerDeps, descriptor: ResourceDescriptor): void {
  const list = instancesFor(descriptor, deps);
  const complete = completionsFor(descriptor, deps);

  /**
   * A template is one definition serving a whole family of addresses. The
   * `{projectId}` is not a wildcard: the SDK matches whole path segments, so
   * `task://projects/fde` resolves and `task://projects/fde/extra` does not —
   * which is what keeps a template an address rather than a glob.
   */
  const template = new ResourceTemplate(descriptor.uri, {
    /**
     * `list` is always passed, even when it is `undefined` — the SDK's type
     * requires the key to be present.
     *
     * Passing `undefined` is the meaningful case: it is how a template says
     * *"these addresses exist, but I will not enumerate them for you"*. That is
     * exactly what `user://{userId}/profile` wants, and it is a stronger
     * statement than omitting the key.
     */
    list,
    ...(complete === undefined ? {} : { complete }),
  });

  server.registerResource(
    descriptor.name,
    template,
    metadataOf(descriptor),
    // A template callback receives the resolved URI. The variables have already
    // been extracted by the SDK; `resourceService` re-validates them, because a
    // template variable is user input and user input is never trusted twice.
    async (uri) => readThrough(deps, uri.href),
  );
}
```

### Block-by-block

**Block 1 — the imports (lines 1–7).**

```ts
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { MIME } from "../config/constants.js";
import { ResourceError, toAppError } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import type { ResourceDescriptor } from "../domain/resourceCatalogue.js";
import type { ServerDeps } from "./deps.js";
import { toProtocolError } from "./protocol.js";
```

Note the two imports that are **values** rather than types: `ResourceTemplate` (a constructor) and
`toProtocolError` (a function). Everything else is a type or a constant. And note `toProtocolError` — this is the
file where the wire adapter is actually *used*, which is why it lives in `mcp/` and not in `core/`.

**Block 2 — `readThrough`, the resource path's guard (lines 40–100).**

The doc comment contrasts it with the tool guard explicitly:

> It exists because a resource failure is a **protocol error**, not a result (Notes Ch03 §3.9): nothing executed, no
> model is waiting on a recovery sentence, and there is no `isError` channel to carry one. So this wrapper's job is
> the **opposite** of the tool guard's — it must make the failure *loud on the wire* rather than friendly in the
> context.

That is the same distinction as Chapter 14's, from the other side. The tool guard catches and returns; this one
catches and **rethrows as a protocol error**. Two wrappers because the two primitives fail differently — which is
the taxonomy's first principle.

```ts
async function readThrough(deps: ServerDeps, uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const scheme = uri.slice(0, uri.indexOf(":"));

  if (!deps.allowedSchemes.has(scheme)) {
    deps.metrics.count("resource.refused.scheme");
    deps.logger.warn("resource.refused", { uri, reason: "scheme not allow-listed", scheme });

    throw toProtocolError(
      new ResourceError(
        "FORBIDDEN",
        `Resource scheme "${scheme}" is not served here.`,
        `Use one of the allow-listed schemes: ${[...deps.allowedSchemes].join(", ")}.`,
      ),
    );
  }
  ...
}
```

**The scheme check is the first statement, before any `try` and before any renderer.** The doc comment states why:

> The scheme check happens **before** the read, and that ordering is the security property: a URI outside the
> allowlist never reaches a renderer, so a template cannot become an enumeration oracle over a scheme nobody meant to
> expose.

That is the enforcement point for `deps.allowedSchemes` from Chapter 13 — and it is worth being precise about *when*
it actually fires, because the answer is narrower than it first appears. With the allowlist reduced to `task`, talking
to the server **directly**:

```bash
MCP_ALLOWED_RESOURCE_SCHEMES=task npx tsx src/index.ts &
# then, from a raw MCP client:
#   user://123/profile   -> Resource scheme "user" is not served here.   ← THIS check fires
#   file:///etc/passwd   -> Resource not found: file:///etc/passwd       ← the SDK's router, earlier
#   task://backlog       -> OK
```

| URI | Refused by | Why |
| :--- | :--- | :--- |
| `user://123/profile` | **This check** | `user://{userId}/profile` **is** a registered descriptor, so the SDK's router passes it through — and the deployment did not allow-list `user` |
| `file:///etc/passwd` | The SDK's router | No descriptor matches, so no handler ever runs |
| `task://backlog` | Nobody | Allow-listed, and registered |

So the allowlist's real job is the **first** row: it stops a *registered* descriptor from being served under a scheme
the deployment did not intend. That is a case the SDK cannot know about, because it has no opinion on which schemes
are appropriate for this application — and it is exactly what Chapter 13 predicted: *defence in depth, not the first
gate.*

The server's log confirms which check fired:

```json
{"event":"resource.refused","server":"task-mcp-server","uri":"user://123/profile","reason":"scheme not allow-listed","scheme":"user"}
```

Three details:

**`uri.slice(0, uri.indexOf(":"))`** extracts the scheme by slicing rather than by regex, and it does **not**
lower-case — a real asymmetry with `catalogue.schemeOf` (Chapter 08), which does. In practice this does not bite: the
allowlist from config is already lower-cased (Chapter 02), and the SDK's router is case-sensitive, so a
`TASK://backlog` is refused before this check ever runs. Verified through the host, which reports
`Refused to read TASK://backlog — the URI does not match any advertised Resource.` Either way the direction of
failure is **closed**, which is the property that matters.

**The metric and the log come before the throw**, so a refused scheme is always visible. `resource.refused.scheme`
is a dedicated counter: a spike in it means someone is probing, which is a different operational signal from a
`NOT_FOUND`.

**`FORBIDDEN` with a recovery sentence that lists the allowlist** — generated from
`[...deps.allowedSchemes]`, so the message names the real configured schemes rather than a hard-coded list. Same
discipline as Chapter 11's prompt menu.

**The success path, which is where the metrics live:**

```ts
try {
  const read = await withTimeout(() => deps.resources.read(uri), deps.resourceTimeoutMs, uri, "resource");

  deps.metrics.count("resource.ok");
  deps.metrics.count(`resource.read.${read.descriptor.name}`);
  deps.metrics.count(`resource.source.${read.source}`);
  deps.metrics.observe("resource.chars", read.chars);
  deps.logger.info("resource.read", { uri, name: read.descriptor.name, kind: read.descriptor.kind, source: read.source, chars: read.chars });

  return { contents: [{ uri: read.uri, mimeType: read.mimeType, text: read.text }] };
}
```

Five observations:

**`withTimeout(..., deps.resourceTimeoutMs, uri, "resource")`** — the *resource* budget and the `"resource"` origin.
The origin is what makes a timeout surface as a protocol error rather than an `isError` result (Chapter 06).

**`resource.source.${read.source}`** — a counter *labelled by cache outcome*. So `resource.source.cache` and
`resource.source.live` are separate metrics, which is what makes Chapter 10's `source` field operationally useful
rather than merely informative: you can watch the cache hit rate as a metric, not just as a log line.

**`deps.metrics.observe("resource.chars", read.chars)`** — the size distribution of Resource bodies. Chapter 04
argued that `context.chars` is the Lecture-15-specific metric; this is its counterpart on the server side, and it
is measured **before** any budget clipping (Chapter 10's `chars` field), so it reports the true document size.

**The log line carries four fields** — `uri`, `name`, `kind`, `source`, `chars`. `kind` distinguishes static from
dynamic from template; `source` distinguishes cache from live. Together they answer "what was read, what shape was
it, and was it free?"

**The return shape is `{ contents: [ … ] }` — an array.** The comment on `registerFixed` below explains: *`resources/read`
returns an **array** of contents. Text resources use `text`; a PDF or an image would use a base64 `blob` instead.*
So the protocol allows a multi-part read, and this server always returns exactly one part.

**The failure path (lines 85–99).**

```ts
} catch (error) {
  const failure = toAppError("resource", error, uri);

  deps.metrics.count("resource.error");
  deps.metrics.count(`resource.error.${failure.code}`);
  deps.logger.warn("resource.failure", { uri, code: failure.code, message: failure.message });

  throw toProtocolError(failure);
}
```

`toAppError` **then** `toProtocolError` — and that two-step is the entire Chapter 05 round trip on the way out. The
first reclassifies whatever was thrown into the taxonomy (so a raw `Error` from the SDK becomes a classified
failure); the second encodes the class into a JSON-RPC error with the recovery sentence in `data`. The doc comment
names both cases:

> A missing resource becomes JSON-RPC `ResourceNotFound` (-32002) — the same code the SDK's own `ResourceNotFoundError`
> produces, which is why this module does not special-case it. A malformed template variable becomes `InvalidParams`
> (-32602). Both reach the host as a *protocol error*, which is the correct shape: nothing executed, so there is no
> `isError` channel and no model waiting on a recovery sentence (Notes Ch03 §3.9).

Note the `throw` — unlike the tool guard, which returns. **A resource failure is loud on the wire.**

**Block 3 — `metadataOf` (lines 102–109).**

```ts
/** The metadata every registration shares — four fields, written once. */
function metadataOf(descriptor: ResourceDescriptor) {
  return {
    title: descriptor.title,
    description: descriptor.description,
    mimeType: descriptor.mimeType,
  };
}
```

*Four fields, written once* — the comment says four and the function returns three, which is worth noting only because
the fourth is implicit: `name`, the first positional argument to `registerResource`. So the four fields a client sees
are `name`, `title`, `description`, `mimeType`, and three of them come from here.

The point of the helper is that `registerFixed` and `registerTemplate` both need it, and writing the object literal
twice would mean a descriptor field could be added to one registration path and forgotten in the other. Same
single-source-of-truth discipline as `argumentsOf` in Chapter 11.

And note what is *not* in the metadata: `audience`, `cache`, `kind` and `keywords`. Those are **server-side**
concerns — the ACL, the cache policy, the renderer dispatch and the ranker. A client has no use for them and should
not be told them, which is why the projection exists rather than passing the descriptor through.

**Block 4 — the registration loop (lines 111–119).**

```ts
export function registerResources(server: McpServer, deps: ServerDeps): void {
  for (const descriptor of deps.catalogue.descriptors()) {
    if (descriptor.kind === "template") {
      registerTemplate(server, deps, descriptor);
    } else {
      registerFixed(server, deps, descriptor);
    }
  }
}
```

**Six lines, and this is the "declarative" claim in its entirety.** No Resource is named; the loop walks the
catalogue and dispatches on `kind`. Add a descriptor and it is registered; remove one and it is not. The registrar has
no knowledge of `guidelines`, `backlog` or `user-profile` as such.

**Block 5 — `registerFixed`, where STATIC and DYNAMIC share a registration (lines 121–139).**

```ts
/**
 * STATIC and DYNAMIC share one registration, because the only difference between
 * them is whether the renderer reads live state — and that is
 * `resourceService`'s business, not the protocol layer's.
 *
 * The protocol layer's job is the three fields a client needs and nothing more:
 * where it lives, what it is called, and what the bytes are.
 */
function registerFixed(server: McpServer, deps: ServerDeps, descriptor: ResourceDescriptor): void {
  server.registerResource(
    descriptor.name,
    descriptor.uri,
    metadataOf(descriptor),
    async (uri) => readThrough(deps, uri.href),
  );
}
```

**The doc comment is a layering argument.** STATIC and DYNAMIC differ in whether their body is computed from live
state — and that difference is invisible at this layer, because the renderer is chosen inside `resourceService`
(Chapter 10). So the protocol layer registers both identically and the distinction lives one layer down, where it
belongs.

*The protocol layer's job is the three fields a client needs and nothing more: where it lives, what it is called, and
what the bytes are.* That is a clean statement of the boundary: `descriptor.uri` (where), `descriptor.name` +
`metadataOf` (what it is called), and the callback (what the bytes are). Nothing else about a Resource appears in this
function.

**`async (uri) => readThrough(deps, uri.href)`** — the callback receives a `URL` object from the SDK, and
`.href` is what turns it back into the string the rest of the codebase speaks. That is a small adapter at the
boundary, and it is why everything below this line can work with plain strings.

**Block 6 — the two hook types, and why they are annotated (lines 141–150).**

```ts
/**
 * The two optional template hooks, typed explicitly.
 *
 * The annotations are not decoration: without them TypeScript widens each
 * `switch` branch into a union whose absent keys are typed `undefined`, which
 * cannot satisfy the SDK's index-signature contract. Naming the shape is both
 * the fix and the documentation.
 */
type ResourceEntry = { uri: string; name: string; title?: string; mimeType?: string };
type ListInstances = () => Promise<{ resources: ResourceEntry[] }>;
type Completions = Record<string, () => string[]>;
```

Three type aliases, and the comment explains why they are needed at all. The problem: `instancesFor` below is a
`switch` returning an object literal in one branch and `undefined` in another. Without an explicit return type,
TypeScript infers a **union of the two shapes**, and in the union the properties absent from one member are typed
`undefined` — which does not satisfy the SDK's index-signature contract. Declaring `ListInstances` forces the return
into one shape.

That is a genuine TypeScript footgun and the fix is exactly right: *naming the shape is both the fix and the
documentation.* And `Completions = Record<string, () => string[]>` documents the protocol's shape in one line — a
completion hook is a map from *variable name* to a function producing candidate values.

Note `ResourceEntry` has `title?` and `mimeType?` optional. That mirrors the protocol, where a listed instance may
omit them — and it means `instancesFor` can supply only the fields it knows.

**Block 7 — `instancesFor`, and the deliberate absence (lines 152–187).**

```ts
function instancesFor(descriptor: ResourceDescriptor, deps: ServerDeps): ListInstances | undefined {
  switch (descriptor.name) {
    case "task":
      return async () => ({
        resources: deps.tasks.list().map((task) => ({
          uri: `task://tasks/${task.id}`,
          name: `task-${task.id}`,
          title: task.title,
          mimeType: MIME.json,
        })),
      });

    case "project":
      return async () => ({
        resources: deps.tasks.stats().projects.map((project) => ({
          uri: `task://projects/${project}`,
          name: `project-${project}`,
          title: `Project ${project}`,
          mimeType: MIME.text,
        })),
      });

    default:
      return undefined;
  }
}
```

**`resources/list` for a template's instances**, and the doc comment states the property that makes it worth
computing:

> Computing them from live state rather than hardcoding them is the whole point: **the catalogue a client sees is
> derived from the same source the tools mutate, so it cannot go stale.**

That is a real correctness property, and it is observable. `deps.tasks.list()` and `deps.tasks.stats().projects` are
the *same* service the tools write through, so creating a task immediately adds a `task://tasks/N` instance to the
next `resources/list`. A hard-coded list would drift from the board the moment anything changed — and the drift would
be silent, because a stale catalogue looks exactly like a correct one.

Two details per case:

| Case | Source | Derived `name` | Derived `title` |
| :--- | :--- | :--- | :--- |
| `task` | `deps.tasks.list()` | `task-${task.id}` | `task.title` (live) |
| `project` | `deps.tasks.stats().projects` | `project-${project}` | `` `Project ${project}` `` (composed) |

The `name` is derived from the variable in both cases — `task-1`, `project-fde` — which is why no one maintains a
list of names. And the `title` differs in kind: a task's is real data (`"Write MCP notes"`), a project's is composed
(`"Project fde"`) because a project is only a slug and has no title of its own.

**And then the absence, which the doc comment calls out:**

> Note which template is **absent**. `user://{userId}/profile` deliberately has no `list`, because **enumerating every
> user's profile is an enumeration oracle** — the exact failure mode Chapter 04 warns about. A client may read a
> profile it already has the id for; it may not ask for the set of all of them.

`default: return undefined` is therefore doing security work, not error handling. There is no `case "user-profile"`,
and its absence means the `user-profile` template is registered **without** a `list` hook — so `resources/list`
never enumerates profiles. Chapter 08's verify section showed the consequence: nine instances, three templates, and
`user://{userId}/profile` appears only as a template.

The distinction being drawn is precise: *a client may read a profile it already has the id for; it may not ask for
the set of all of them.* Possession of an id is the authorisation to read it (subject to the ACL); the absence of a
list is what stops an id from being *discovered*.

**Block 8 — `completionsFor`, and the same absence for the same reason (lines 189–204).**

```ts
function completionsFor(descriptor: ResourceDescriptor, deps: ServerDeps): Completions | undefined {
  switch (descriptor.name) {
    case "task":
      return { taskId: () => deps.tasks.list().map((task) => String(task.id)) };

    case "project":
      return { projectId: () => [...deps.tasks.stats().projects] };

    default:
      return undefined;
  }
}
```

**`completion/complete` for a template's variables**, so a host can offer suggestions while the user types a URI
instead of making them guess. The doc comment ties it to the absence above:

> `user-profile` has no completions for the same reason it has no `list`: the server has no session, so it cannot know
> whose id is being typed, and offering the full set would be **the oracle again by another route**.

That is the argument worth dwelling on, because it is easy to think of completions as a *convenience* rather than an
information channel. A completion hook that returned every user id would answer "which users exist?" to anyone who
typed a single character — and it would do so through an endpoint nobody thought of as a data source. **The oracle
again by another route** is exactly right: the same leak, through a different door.

The two that *are* implemented are safe because their value sets are not sensitive:

| Hook | Returns | Why it is safe |
| :--- | :--- | :--- |
| `taskId` | `String(task.id)` for every task | Task ids are already visible in `resources/list` and `list_tasks` |
| `projectId` | `[...deps.tasks.stats().projects]` | Project slugs are already in the catalogue listing |

Both are things the client could already enumerate, so offering them as completions leaks nothing. That is the test:
**a completion hook is safe exactly when its output is already publicly enumerable.**

Note `String(task.id)` — a small conversion with a real purpose, because the protocol's completions are strings. And
`[...deps.tasks.stats().projects]` — a spread, because the stats array is `readonly` and the hook's return type is
`string[]`. Both are the kind of detail that would be a type error if forgotten.

**Block 9 — `registerTemplate` (lines 206–244).**

```ts
function registerTemplate(server: McpServer, deps: ServerDeps, descriptor: ResourceDescriptor): void {
  const list = instancesFor(descriptor, deps);
  const complete = completionsFor(descriptor, deps);

  const template = new ResourceTemplate(descriptor.uri, {
    list,
    ...(complete === undefined ? {} : { complete }),
  });

  server.registerResource(
    descriptor.name,
    template,
    metadataOf(descriptor),
    async (uri) => readThrough(deps, uri.href),
  );
}
```

**The template comment names the grammar, echoing Chapter 08:**

> A template is one definition serving a whole family of addresses. The `{projectId}` is not a wildcard: the SDK
> matches whole path segments, so `task://projects/fde` resolves and `task://projects/fde/extra` does not — which is
> what keeps a template an address rather than a glob.

So the SDK's own matcher agrees with the catalogue's `compileTemplate` (Chapter 08) about the grammar. That is worth
noting as a *consistency* rather than a coincidence: the catalogue's matcher exists so the *application* can resolve a
URI without a round trip, and the SDK's exists so the *server* can route a request. Both must agree, and both use
whole-segment matching.

**The `list` option is always passed, even when it is `undefined`** — and the comment explains why that is not a
mistake:

> `list` is always passed, even when it is `undefined` — the SDK's type requires the key to be present.
>
> Passing `undefined` is the meaningful case: it is how a template says *"these addresses exist, but I will not
> enumerate them for you"*. That is exactly what `user://{userId}/profile` wants, and it is **a stronger statement
> than omitting the key**.

That distinction is subtle and correct. `list: undefined` says *"this template deliberately does not enumerate"*,
while omitting the key says nothing in particular. Since the SDK's type requires the key, the explicit `undefined` is
both legal and semantically loaded — and it is what makes `user-profile`'s refusal to enumerate a *declared* refusal
rather than an accident of not having written a hook.

**`complete` is spread conditionally:**

```ts
...(complete === undefined ? {} : { complete }),
```

Unlike `list`, `complete` is genuinely optional, so the object is spread or not. The reason for the difference is in
the SDK's types — `list` is a required key whose value may be `undefined`, `complete` is a key that may be absent.
Working with that asymmetry rather than fighting it is what the two lines are doing.

**The read callback is the same one `registerFixed` uses:**

```ts
async (uri) => readThrough(deps, uri.href),
```

Both registration paths funnel through `readThrough`, so a scheme check, a timeout, the metrics and the protocol-error
mapping apply identically to static, dynamic and templated reads. That is the payoff of the shared wrapper: three
shapes, one read path.

And the comment on the callback names the validation boundary:

> A template callback receives the resolved URI. The variables have already been extracted by the SDK;
> `resourceService` re-validates them, because **a template variable is user input and user input is never trusted
> twice.**

That is Chapter 09's re-validation rule, restated for the resource path. The SDK extracted `{taskId: "abc"}` from the
URI; `resourceService`'s `coercePositiveInt` then rejects it. Two independent checks on the same value, from two
layers that do not trust each other — which is the correct posture when one of them is a library and the value came
from a user.

---

## Run / verify

### 1. The three shapes, all through one verb

```bash
npm run lifecycle 2>/dev/null | sed -n '/^5\./,/^6\./p'
```

```text
5. resources/read -> static, templated and JSON, all through one verb
   task://guidelines        STATIC    310 chars, text/plain
   task://projects/fde      TEMPLATE  134 chars
   Project: fde | Tasks: 2 |  | - [high] Write MCP notes  (project: fde, owner: 123) | - [normal] Review pull request  …(+32)
   task://tasks/1           TEMPLATE  214 chars, application/json
   { "id": 1, "title": "Write MCP notes", "status": "PENDING", "priority": "high", "projectId": "fde", "owner": "…(+88)
```

Three Resources, three different stories, **one verb** — `resources/read`. That is the protocol's contribution: the
client does not need a different call for a constant, a computed body or a family member. And all three went through
the same `readThrough`, so all three got the scheme check, the timeout, the metrics and the same error mapping.

Note the labels the walkthrough prints — `STATIC` and `TEMPLATE` — come from `descriptor.kind`, which is why `kind`
is in the boot log (Chapter 10) and in the `resource.read` log line (Block 2). Three shapes, one read path, and the
shape is reported rather than assumed.

### 2. A missing Resource is a protocol error, not an `isError` result

```bash
npm run lifecycle 2>/dev/null | sed -n '/^6\./,/^7\./p'
```

```text
6. failures    -> a missing Resource is a protocol error, not an isError result
   task://tasks/999         -> No task with id 999.
   task://nope              -> Resource not found: task://nope
   file:///etc/passwd       -> Resource not found: file:///etc/passwd
```

Three refusals, and the *messages* tell you which layer refused:

| URI | Message | Refused by |
| :--- | :--- | :--- |
| `task://tasks/999` | `No task with id 999.` | **Our renderer** — the template matched, the id parsed, the task does not exist |
| `task://nope` | `Resource not found: task://nope` | The SDK's router — no descriptor matches |
| `file:///etc/passwd` | `Resource not found: file:///etc/passwd` | The SDK's router — no descriptor matches |

The first line is ours; the other two are the SDK's. That is why the walkthrough's header says *"a missing Resource is
a **protocol error**, not an `isError` result"* — all three arrived as JSON-RPC errors, and none of them as content with
`isError: true`. Compare Chapter 14's tool failures, which are `isError` results. **Same kind of problem, two different
wire shapes, because the two primitives fail differently** (Ch03 §3.9).

### 3. The completion hooks, and the one that is absent

```bash
# from a raw MCP client
#   complete task://tasks/{taskId}      argument taskId
#   complete task://projects/{projectId} argument projectId
#   complete user://{userId}/profile     argument userId
```

```text
taskId completions:    ["1","2","3","4"]
projectId completions: ["fde","media"]
userId completions:    []  <- would be the oracle
```

Three requests, three outcomes, and the third is the design:

| Template | Hook | Result |
| :--- | :--- | :--- |
| `task://tasks/{taskId}` | `completionsFor` → `case "task"` | `["1","2","3","4"]` — the live task ids |
| `task://projects/{projectId}` | `completionsFor` → `case "project"` | `["fde","media"]` — the live project slugs |
| `user://{userId}/profile` | **no hook** | `[]` — **nothing offered** |

**The first two are safe because their output is already enumerable.** `taskId` values appear in `resources/list` and
in `list_tasks`; project slugs appear in the catalogue listing. So offering them as completions leaks nothing the
client could not already obtain.

**The third returns an empty list rather than an error.** That is worth stating precisely, because it is better than
what a reader might expect: the SDK answers a completion request for a template with no hook by returning
`{ values: [] }` rather than by failing. So the observable behaviour is *"no suggestions"*, which:

- leaks **nothing** — no user ids, no count, not even the existence of other users,
- and does not turn a host's type-ahead into an error the user has to understand.

That is the right shape for a deliberate refusal: silence, not a message that confirms there is something to hide.
And note the doc comment's framing applies exactly — *offering the full set would be the oracle again by another
route.* A completion hook for `userId` would have answered "which users exist?" to anyone who typed one character,
through an endpoint nobody thinks of as a data source.

### 4. The scheme check, and which layer wins

Chapter 13's verification and the correction above: with the allowlist reduced to `task` and a **raw client**, the
server's own check fires for a *registered* descriptor:

```text
user://123/profile  -> Resource scheme "user" is not served here.
file:///etc/passwd  -> Resource not found: file:///etc/passwd
```

And through the **HTTP host**, both are refused earlier still — by the host's own catalogue and scheme allowlist:

```bash
curl -s 'http://127.0.0.1:8080/read?uri=file:///etc/passwd'
```

```json
{"error":{"code":"FORBIDDEN","message":"Refused to read file:///etc/passwd — scheme \"file\" is not in the host allow-list.","recovery":"Read a Resource the session is entitled to, or ask an administrator for access.","retryable":false,"requestId":"5addc0c7"}}
```

*"is not in the **host** allow-list"* — the host refuses before the wire, so the server's check is the second line of
defence rather than the first. Three layers, and each is observable by which message you get:

| Layer | Message shape | When it fires |
| :--- | :--- | :--- |
| Host policy | `scheme "file" is not in the host allow-list` | Every request through the HTTP host |
| SDK router | `Resource not found: <uri>` | A raw client asking for an unregistered URI |
| This check | `Resource scheme "user" is not served here.` | A raw client asking for a registered descriptor under a non-allow-listed scheme |

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

---

## Checkpoint

1. **What makes the registration "declarative"?**
   The loop walks `deps.catalogue.descriptors()` and dispatches on `kind`. No Resource is named in the registrar, so
   adding one means editing the descriptor table (and adding a renderer, which the boot-time invariant enforces).

2. **Why do STATIC and DYNAMIC share one registration function?**
   Because the only difference between them is whether the renderer reads live state — and that is `resourceService`'s
   business, not the protocol layer's. The protocol layer registers *where it lives, what it is called, and what the
   bytes are*.

3. **Why does the scheme check come before the `try` and before the read?**
   So a URI outside the allowlist never reaches a renderer — the ordering *is* the security property. It fires for a
   *registered* descriptor under a non-allow-listed scheme, which is the case the SDK's router cannot know about.

4. **Why is a resource failure thrown rather than returned?**
   Because a resource failure is a **protocol error**: nothing executed, there is no `isError` channel on
   `resources/read`, and no model is waiting on a recovery sentence. The tool guard returns; this one rethrows.

5. **Why does `user://{userId}/profile` have no `list` hook?**
   Because enumerating every profile is an **enumeration oracle**. A client may read a profile it already has the id
   for; it may not ask for the set of all of them. Passing `list: undefined` explicitly is a stronger statement than
   omitting the key.

6. **Why does it have no `completion` hook either?**
   Because the server has no session, so it cannot know whose id is being typed — and offering the full set would be
   the oracle by another route. Verified: the request returns `[]` rather than an error, so nothing is leaked and the
   host's type-ahead does not fail.

7. **What is the test for whether a completion hook is safe?**
   Its output must already be publicly enumerable. `taskId` and `projectId` values are already in `resources/list` and
   `list_tasks`; user ids are not.

8. **Why are the two hook types declared explicitly rather than inferred?**
   Because a `switch` returning an object in one branch and `undefined` in another infers a *union* whose absent keys
   are `undefined`, which does not satisfy the SDK's index-signature contract. Naming the shape is both the fix and
   the documentation.

---

**[← Chapter 14: The Tools Primitive](./14_Mcp_Tools.md)** · **[Chapter 16: The Prompts Primitive →](./16_Mcp_Prompts.md)**

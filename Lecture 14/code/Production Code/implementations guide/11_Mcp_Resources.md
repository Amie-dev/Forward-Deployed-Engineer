# Chapter 11: MCP — Resources & Templates

> **Chapter goal:** Expose *knowable* context — read-only, addressable by URI, driven by
> the application — and show why a **template** is the right shape for a family of
> addresses while a **static resource** is the right shape for a fixed document.

---

## 11.1 File details

| | |
| :--- | :--- |
| **Path** | `src/mcp/resources.ts` |
| **Layer** | mcp (imports the SDK, `config/env`, `./deps`) |
| **Purpose** | Register two static policy resources and one resource **template** (`company://tasks/{taskId}`) whose instances are computed from live state, with autocompletion for the `{taskId}` variable |
| **Imports** | `ResourceNotFoundError`, `ResourceTemplate`, `type McpServer` from the SDK; `URI_SCHEME`; `ServerDeps` |
| **Exports** | `registerResources()` |
| **Consumed by** | `src/mcp/server.ts` |
| **Lecture sections** | [06 — Resources and Prompts](../../../notes/06_Resources_and_Prompts.md) §6.2–6.4 (the URI is the identity; templates; `resources/read`) |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# both catalogues and a templated read
npm run host | sed -n '33,37p'
```

---

## 11.2 Full file

```ts
import { ResourceNotFoundError, ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { URI_SCHEME } from "../config/env.js";
import type { ServerDeps } from "./deps.js";

/**
 * Chapter 06 §6.2–6.4 — Resources: addressable context.
 *
 * A Resource is *know*, not *do*: the application — never the model — decides to
 * read it, the content is read-only, and **the URI is the identity**. Reading a
 * resource executes nothing, which is exactly why a resource is the right shape
 * for a policy document and the wrong shape for an operation.
 *
 * Two shapes are registered below, and the difference between them is the
 * lesson:
 *
 *  · a **static resource** is one address with fixed content;
 *  · a **template** is a *family* of addresses — `company://tasks/{taskId}` —
 *    whose instances are computed at `resources/list` time. This is how you
 *    expose "any task" without pretending to enumerate every task in code, and
 *    it is why a template can never drift from live state.
 */

/** Fixed content, fixed addresses. Read-only by construction. */
const POLICIES: Record<string, string> = {
  "return-policy":
    "Returns are accepted within 30 days of delivery. Electronics must include the original packaging.",
  "refund-policy": "Refunds are issued to the original payment method within 5 business days of approval.",
};

export function registerResources(server: McpServer, deps: ServerDeps): void {
  for (const [name, text] of Object.entries(POLICIES)) {
    const uri = `${URI_SCHEME}://policies/${name}`;

    server.registerResource(
      name,
      uri,
      {
        title: name.replace(/-/g, " "),
        description: `Company policy exposed as addressable context at ${uri}`,
        mimeType: "text/plain",
      },
      // `resources/read` returns an array of contents. Text resources use
      // `text`; a PDF or an image would use a base64 `blob` instead.
      async (readUri) => ({
        contents: [{ uri: readUri.href, mimeType: "text/plain", text }],
      }),
    );
  }

  const taskTemplate = new ResourceTemplate(`${URI_SCHEME}://tasks/{taskId}`, {
    /**
     * `resources/list` for the template's instances.
     *
     * Computing them from live state rather than hardcoding them is the whole
     * point: the catalogue a client sees is derived from the same source the
     * tools mutate, so it cannot go stale.
     */
    list: async () => ({
      resources: deps.service.list().map((task) => ({
        uri: `${URI_SCHEME}://tasks/${task.id}`,
        name: `task-${task.id}`,
        title: task.title,
        mimeType: "application/json",
      })),
    }),

    /**
     * `completion/complete` for the `{taskId}` variable, so a host can offer
     * suggestions while the user types a URI instead of making them guess.
     */
    complete: {
      taskId: () => deps.service.list().map((task) => String(task.id)),
    },
  });

  server.registerResource(
    "task",
    taskTemplate,
    {
      title: "Task",
      description: "One task as addressable JSON, addressed by id",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.taskId;
      const id = Array.isArray(raw) ? raw[0] : raw;
      const task = deps.service.find(id);

      /**
       * A missing resource is a **protocol error**, not a tool result: there is
       * no `isError` mechanism on `resources/read`, because nothing executed and
       * no model is waiting on a recovery instruction. `ResourceNotFoundError`
       * says precisely that on the wire.
       */
      if (task === undefined) {
        throw new ResourceNotFoundError(uri.href);
      }

      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(task, null, 2) }],
      };
    },
  );
}
```

## 11.3 Block-by-block explanation

### Block 1 — the mental model, and the control inversion

The header comment opens with the distinction that makes resources worth having:

> A Resource is *know*, not *do*: the application — never the model — decides to read it,
> the content is read-only, and **the URI is the identity**.

Three claims, and each one is load-bearing.

**"*know*, not *do*"** — Chapter 06's mental model. Tools are what the AI *does*;
resources are what the AI *knows*. The practical consequence is that reading a resource
**executes nothing**. There is no side effect to reason about, no rate limit that matters,
no consent gate, no idempotency key. That is why a policy document is a resource and a
task creation is a tool.

**"the application — never the model — decides to read it"** — this is a *control
inversion*, and it is the part people find surprising. A tool is driven by the model: it
appears in `tools/list`, the model chooses it, and the host invokes it. A resource is
driven by the **host application**: the host decides to fetch `company://policies/return-policy`
and place it in the context, usually in response to something the user did (opening a
document, selecting a file, following a link).

The model never issues a `resources/read`. It cannot — the protocol does not give it that
verb. So the security surface is smaller by construction: a resource that should not be
read is one the host simply never fetches, and a prompt injection cannot talk the host
into fetching it, because the decision is not made in the prompt.

**"the URI is the identity"** — an addressable resource has an address, and the address is
stable, unique and meaningful. That is what makes a resource *referenceable* — a prompt
can point at a URI, a log can record a URI, and a host can cache by URI. A tool has a
name; a resource has an address.

### Block 2 — `POLICIES`: static resources, and why a `Record` is the right shape

```ts
const POLICIES: Record<string, string> = {
  "return-policy":
    "Returns are accepted within 30 days of delivery. Electronics must include the original packaging.",
  "refund-policy": "Refunds are issued to the original payment method within 5 business days of approval.",
};
```

**What it does:** holds the fixed content of the two static resources.
**How it works:** a plain record keyed by the resource's *name*, with the content as the
value.

**Why a `Record` and not an array of objects?** Because the loop below needs both the key
and the value, and `Object.entries` gives both. An array would require
`{ name, text }` objects and a `.map` — more ceremony for the same result. The key *is*
the name, so storing it twice would invite the two copies to drift.

**Why is the content a `string` and not an object?** Because these are text documents, and
`mimeType: "text/plain"` declares that. A resource whose content is a JSON object would
store `JSON.stringify(...)` or, better, a structured value serialised at read time — which
is exactly what the template does (Block 5).

**The keys are the URI path segment, and the hyphen is meaningful.**
`return-policy` becomes `company://policies/return-policy`. Hyphens are conventional in
URIs (they are valid in a path segment, unlike spaces), and the `name.replace(/-/g, " ")`
below turns them into a human title. So the key is doing triple duty: URI segment,
resource name, and title source. That is acceptable for two entries and would not be for
twenty — at which point the title would become an explicit field.

**The content is deliberately short.** A policy document in a demo is one sentence; a real
one is a PDF. That is why the comment on the read callback mentions `blob`: the same
registration works for binary content, and the only change is the content shape.

### Block 3 — the static registration loop

```ts
for (const [name, text] of Object.entries(POLICIES)) {
  const uri = `${URI_SCHEME}://policies/${name}`;

  server.registerResource(
    name,
    uri,
    {
      title: name.replace(/-/g, " "),
      description: `Company policy exposed as addressable context at ${uri}`,
      mimeType: "text/plain",
    },
    async (readUri) => ({
      contents: [{ uri: readUri.href, mimeType: "text/plain", text }],
    }),
  );
}
```

**What it does:** registers one resource per policy, with the content captured in the
closure.
**How it works:** `registerResource(name, uri, metadata, readCallback)` — the *string*
overload, for a single fixed address.

**`const uri = ...` is hoisted out of the `registerResource` call** so the same value can be
used twice: once as the address, once inside the `description`. That is a small thing, but
it means the description cannot disagree with the address it describes.

**The read callback closes over `text`.** Note that the callback takes `readUri` but ignores
the content and returns the captured `text`. That is the whole point of a static resource:
the content is a constant, decided at registration time. The callback receives the URI only
so it can echo it back in `contents[0].uri` — which is required, because the client matches
the response to its request by URI.

**`readUri.href` rather than the original `uri` string.** The callback's parameter is a
`URL` object (the SDK parses the URI before dispatch), and `.href` normalises it. Using the
original string would work for these two, but `.href` is correct for any URI with an escape
or a non-ASCII character, where the parsed-then-serialised form differs from the input.

**`contents` is an array, always.** Even for a single text document. That mirrors the tools'
`content[]` shape and leaves room for a resource whose read returns several blocks (a
document plus a thumbnail, say). `[{ uri, mimeType, text }]` is the minimal valid form.

**`description` includes the URI, which looks redundant.** It is not: `resources/list`
returns a list a *human* may read in an inspector UI, and seeing the address alongside the
title removes the need to look it up. It costs twelve characters in a payload that is
already carrying a title and a MIME type.

### Block 4 — `ResourceTemplate`: the family, not the instance

```ts
const taskTemplate = new ResourceTemplate(`${URI_SCHEME}://tasks/{taskId}`, {
  list: async () => ({
    resources: deps.service.list().map((task) => ({
      uri: `${URI_SCHEME}://tasks/${task.id}`,
      name: `task-${task.id}`,
      title: task.title,
      mimeType: "application/json",
    })),
  }),

  complete: {
    taskId: () => deps.service.list().map((task) => String(task.id)),
  },
});
```

**What it does:** describes a *family* of addresses, and how to enumerate its current
members.
**How it works:** `new ResourceTemplate(uriTemplate, { list, complete? })` — two callbacks,
each answering a different protocol request.

**This is the block that justifies the chapter.** Without templates you have two options,
both bad:

| Approach | Problem |
| :--- | :--- |
| Register a static resource per task | `registerResource` is called inside `create_task` — which the SDK forbids after `connect()` (`ALREADY_CONNECTED`), and which would require re-registering on every mutation |
| Expose `company://tasks/all` as one big resource | One address for N documents; the client cannot address a single task, and the whole board must be read to get one row |

A template solves both. The *pattern* is registered once, at construction time; the
*instances* are computed whenever a client asks. No dynamic registration, no giant blob.

**`list` is required, even when it would be `undefined`.** The SDK's `ResourceTemplate`
constructor signature makes `list` mandatory on purpose — its own documentation says so, "to
avoid accidentally forgetting resource listing". That is a good API decision: a template
whose instances are invisible in `resources/list` is a template a host cannot discover, and
the SDK refuses to let you create one by accident.

**The instances are computed from live state, and that is the point.** The comment says it:
*"the catalogue a client sees is derived from the same source the tools mutate, so it cannot
go stale."* Compare the alternative — a hardcoded array of task URIs — which would drift the
moment a task was created or deleted, and would present a host with addresses that return
`ResourceNotFoundError`.

**`title: task.title`** — the task's own title becomes the resource's display title. That is
what makes a URI list readable in a picker: `company://tasks/1` with the title "Record MCP
Video" is self-describing, whereas the URI alone is not.

**`name: \`task-${task.id}\``** — the name must be unique within the list, and it is what a
client uses as a stable identifier in its own UI. Prefixing with `task-` keeps it
distinguishable from the policy resources (`return-policy`, `refund-policy`), which share
the same flat namespace.

**`complete.taskId` powers `completion/complete`.** When a host offers a URI input box, it can
ask the server for suggestions for the `{taskId}` variable, and this callback supplies the
current ids as strings. Note the `String(task.id)` — completion values are always strings,
because the template grammar is untyped. **This is the same fact that forced the coercion in
`taskService.find`** (Chapter 08): the URI world has no numbers.

**The two callbacks both call `deps.service.list()`, and that duplication is fine.** Merging
them would mean one callback returning two different shapes; keeping them separate means
each is a one-liner and each answers exactly one protocol method. The cost is one extra
`list()` call, which is an array copy over an in-memory `Map`.

### Block 5 — the templated read, and the other error mechanism

```ts
server.registerResource(
  "task",
  taskTemplate,
  {
    title: "Task",
    description: "One task as addressable JSON, addressed by id",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const raw = variables.taskId;
    const id = Array.isArray(raw) ? raw[0] : raw;
    const task = deps.service.find(id);

    if (task === undefined) {
      throw new ResourceNotFoundError(uri.href);
    }

    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(task, null, 2) }],
    };
  },
);
```

**What it does:** serves one instance of the template.
**How it works:** the *template* overload of `registerResource` —
`(name, template, metadata, callback)` — where the callback receives the matched URI **and**
the extracted variables.

**`registerResource("task", taskTemplate, …)` takes a name that the static form did not
need.** For a string URI, the first argument is the resource name; for a template, it is the
template's name. Both are required — a template without a name cannot appear in
`resources/templates/list`. The name `"task"` (singular) describes the family, while the
per-instance names in `list()` are `task-1`, `task-2`, …

**`variables.taskId` is `string | string[] | undefined`.** The `Variables` type is
`Record<string, string | string[]>` because a URI template can repeat a variable
(`?id={id}&id={id}`) or capture a wildcard, in which case the SDK collects the matches into an
array. The `Array.isArray(raw) ? raw[0] : raw` guard handles both forms.

With `noUncheckedIndexedAccess` on, `raw[0]` is additionally typed `string | undefined` —
which is *fine here*, because `service.find` accepts `unknown` and returns `undefined` for
anything it cannot parse. A malformed variable therefore becomes a not-found, not a crash.

**`deps.service.find(id)`, not `deps.service.get(id)`.** This is the reason `find` exists as a
separate method (Chapter 08). A tool that cannot find a task has a *model* to inform, so it
throws a `ToolError` with a recovery sentence. This handler has an *application* waiting on a
JSON-RPC response, so it needs the other error mechanism. `find` returns `undefined` and lets
the caller decide; using `get` here would mean catching a `ToolError` and translating it,
which is exactly the kind of translation that gets forgotten when the code changes.

**`throw new ResourceNotFoundError(uri.href)` — a protocol error, on purpose.** The comment
spells out why, and it is the sharpest point in the chapter:

> A missing resource is a **protocol error**, not a tool result: there is no `isError`
> mechanism on `resources/read`, because nothing executed and no model is waiting on a
> recovery instruction.

Compare the two mechanisms side by side:

| | `resources/read` miss | `tools/call` miss |
| :--- | :--- | :--- |
| **Who asked** | the application | the model (via the host) |
| **Mechanism** | thrown `ResourceNotFoundError` → JSON-RPC error | returned result with `isError: true` |
| **On the wire** | `error` object with `code: -32602` and `data.uri` | `result` with `content[]` and `isError` |
| **Recovery text** | none — there is nobody to instruct | required, and it lands in the model's context |

`ResourceNotFoundError` is an SDK-provided class extending `ProtocolError`, so throwing it
produces the correct JSON-RPC error code and a `data: { uri }` payload automatically. The
alternative — throwing a plain `Error` — would produce a generic internal error and lose the
URI, making the failure harder to debug from the client side.

**`JSON.stringify(task, null, 2)` — pretty-printed, unlike the tools.** That asymmetry is
deliberate. A tool result's `text` goes into the *model's context*, where every newline and
indent is a token spent for nothing; a resource's `text` is read by the *application*, often
by a human in an inspector, where indentation is what makes it legible. Different audience,
different formatting.

**`mimeType: "application/json"` is declared in two places** — in the registration metadata
and in each `contents` entry. The metadata tells a client what to expect before it reads; the
per-content value is the authoritative type of the actual bytes. The wire format requires
both, so they are repeated rather than shared.

### Block 6 — why there is no `sendResourceUpdated` here

The lecture's §6.3 lists `resources/subscribe` and `notifications/resources/updated`
alongside `resources/list` and `resources/read`. This server does **not** implement them, and
the reason is worth recording because it was found by experiment rather than by reading:

- The `McpServer` options accept
  `capabilities: { resources: { subscribe: true, listChanged: true } }`, and declaring it
  *does* advertise the capability to clients.
- But `McpServer` does **not** register a handler for `resources/subscribe`. A client that
  calls `subscribeResource` receives `Method not found` — the capability is advertised and the
  method is absent, which is precisely the inconsistency the SDK's own documentation warns
  against ("a server that declares a capability MUST respond to that capability's requests").
- The low-level `Server` exposes `sendResourceUpdated({ uri })`, and it works — the
  notification is delivered. But the matching *request* handler has to be registered by hand,
  and the schema (`SubscribeRequestSchema`) is not exported from the package's runtime entry
  point.

So a correct implementation would have to reach into the low-level `Server` and hand-roll a
handler whose schema is not part of the public API. For a learning codebase that is the wrong
trade: it would add fragility and obscure the lesson. **The honest move is to say so** — which
is what the README's "Honest limits" section does — and to note that
`sendResourceListChanged()` *is* available and is what you would call after adding a resource.

The same experiment produced a second finding, relevant to Chapter 07: **`registerTool` and
`registerResource` cannot be called after `connect()`.** The SDK raises `ALREADY_CONNECTED` —
*"Cannot register capabilities after connecting to transport"*. That is why a template exists
rather than a per-task registration, and why "dynamic discovery" in this SDK means announcing
a change to a fixed catalogue (`sendToolListChanged`) rather than growing the catalogue at
runtime.

---

## 11.4 Run / verify

Both catalogues and a templated read, in one block of the demo:

```bash
npm run host | sed -n '33,37p'
```

```text
8. resources   -> resources/list: company://policies/return-policy, company://policies/refund-policy, company://tasks/1
   templates    -> company://tasks/{taskId}
   read company://policies/return-policy -> 97 chars
   read company://tasks/1 -> { "id": 1, "title": "Record MCP Video", "status": "COMPLETED", "createdAt": "2026-10-23T11:02:50.731Z", "updat…
   read company://tasks/999 -> protocol error: Resource not found: company://tasks/999
```

Four observations:

1. **`resources/list` returns three resources**, and only one comes from the template. The
   two policies are static; `company://tasks/1` was computed by the template's `list` callback
   from live state. Note that it is `1` and not `2` — task #2 was deleted by the consent demo
   earlier in the run. **The catalogue tracked the mutation with no code connecting them**,
   which is the "cannot go stale" claim of Block 4.
2. **`resources/templates/list` returns the pattern**, not an instance:
   `company://tasks/{taskId}`. That is the family, and it is what a host uses to know which
   URIs are addressable.
3. **The templated read returns the task as pretty-printed JSON** — the
   `JSON.stringify(task, null, 2)` from Block 5, with the real timestamps from the store.
4. **The miss is a protocol error**, printed as `protocol error: Resource not found: …`. Not
   an `isError` result. Block 5's distinction, visible in the demo's own output.

Now confirm the behaviour of an **empty** board — the case that makes a template's nature
obvious:

```bash
npx tsx -e '
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
(async () => {
  const client = new Client({ name: "probe", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "src/index.ts"], stderr: "ignore",
  }));

  const list = await client.listResources();
  console.log("resources  :", list.resources.map((r) => r.uri).join(", ") || "(none)");

  const templates = await client.listResourceTemplates();
  console.log("templates  :", templates.resourceTemplates.map((t) => t.uriTemplate).join(", "));

  try {
    await client.readResource({ uri: "company://tasks/1" });
    console.log("read       : company://tasks/1 -> OK");
  } catch (error) {
    console.log("read       : company://tasks/1 ->", error.message);
  }

  await client.close();
})();
'
```

```text
resources  : company://policies/return-policy, company://policies/refund-policy
templates  : company://tasks/{taskId}
read       : company://tasks/1 -> Resource not found: company://tasks/1
```

Read the three lines together, because they describe the template's exact nature:

- `resources/list` shows **only the two policies**. The template contributed nothing, because
  it has no instances — the board is empty in a fresh process.
- `resources/templates/list` still shows the **pattern**. The family is addressable even when
  it has no members.
- The read fails with a **protocol error**, not an `isError` result — the same
  `ResourceNotFoundError` path as `company://tasks/999`, reached for the same reason.

That is the correct and slightly surprising behaviour of a template: **an empty family lists
as empty, while the pattern remains addressable.** A host that wants to know "can this server
give me a task?" must consult `resources/templates/list`, not `resources/list`.

---

## 11.5 Checkpoint

1. **Resources are *know*, not *do*.** Reading one executes nothing — which is why there is no
   rate limit, no consent gate and no idempotency key on this path.
2. **The application drives resources; the model cannot.** The model has no `resources/read`
   verb, so the security surface is smaller by construction.
3. **A static resource is an address; a template is a family.** The pattern is registered once
   at construction, and the instances are computed on demand from live state — so the
   catalogue cannot drift from the data.
4. **URI template variables are always strings**, which is why `complete` returns
   `String(task.id)` and why `taskService.find` coerces rather than rejects.
5. **A missing resource is a protocol error, not an `isError` result.** There is no model to
   instruct, so `ResourceNotFoundError` is the honest mechanism — and it carries the URI.
6. **Resources cannot be registered after `connect()`.** The SDK raises `ALREADY_CONNECTED`,
   which is the real reason the template exists.
7. **`resources/subscribe` is advertised but not implemented by the high-level server.**
   Documented rather than faked.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 10 — MCP: The Tools Primitive](./10_Mcp_Tools.md)

**Next:** [Chapter 12 — MCP: Prompts](./12_Mcp_Prompts.md)





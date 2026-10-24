# Chapter 19 — Host: The Client & Its Verb Wrappers

> **The host's only door to the server.** One function per protocol verb, so the difference between reading a Resource
> and fetching a Prompt is visible on the page — and so that *"what does this application actually do with the
> protocol?"* is a question with a seven-line answer.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/host/client.ts` (228 lines) |
| **Layer** | `host` — the **only** file above `mcp/` that imports the SDK |
| **Purpose** | Wrap the seven protocol verbs the host needs, with cursor-following pagination and two content-shape extractors. |
| **Exports** | `ListedResources`, `ListedTemplates`, `ListedPrompts`, `ListedTools`, `RenderedPrompt`, `ToolCallResult`, `ResourceBody`, `McpClient`, `textOf()`, `resourceText()`, `createMcpClient()` |
| **Lecture sections** | Ch03 §3.1/3.8/3.9 (client, content shapes, pagination), Ch07 §7.2/7.3 |
| **Runs** | `npm run lifecycle` (the walkthrough uses every verb) |

---

## Commands

```bash
# every verb, exercised in order, by the walkthrough
npm run lifecycle 2>/dev/null | grep -E '^[0-9]+\.' 

# the same verbs through the HTTP host
npm run server & npm run host &
curl -s http://127.0.0.1:8080/resources | head -c 200
```

---

## Why seven functions, and not the SDK

The header states the boundary:

> This module is the host's **only door** to the server. Nothing above it imports the SDK, which is what makes the rest
> of `src/host` and all of `src/controllers` testable against a stub — and what keeps the answer to *"what does this
> application actually do with the protocol?"* down to seven functions.

That second clause is the useful one. The SDK's `Client` exposes a large surface — sampling, elicitation, roots,
subscriptions, logging, progress, and more. An application that called it directly would have its protocol usage spread
across every file that needed it, and answering "what does this system do with MCP?" would mean reading all of them.

By wrapping exactly the seven verbs this host needs, the question becomes answerable by reading one interface:

```ts
export interface McpClient {
  readonly raw: Client;
  listResources(): Promise<{ resources: ListedResources; templates: ListedTemplates }>;
  read(uri: string): Promise<ResourceBody>;
  listPrompts(): Promise<ListedPrompts>;
  getPrompt(name: string, args: Record<string, string>): Promise<RenderedPrompt>;
  listTools(): Promise<ListedTools>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}
```

Seven verbs plus `raw`, and the shape of the list is itself informative: **four are discovery or read, one renders a
prompt, one calls a tool, one closes.** No sampling, no elicitation, no subscriptions — because this host does not do
those, and an interface that listed them would be describing a capability the system does not have.

`readonly raw: Client` is the escape hatch, and its comment names it: *for a caller that needs a verb this interface
does not wrap.* The walkthrough uses it for `getServerCapabilities()`, `getServerVersion()` and `getInstructions()`
(Chapter 26) — all read-only inspection, none of them worth a wrapper. So the escape hatch exists and is used for
exactly what it is for, which is a better outcome than either wrapping everything or exposing `raw` alone.

---

## `src/host/client.ts` — the full file

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";

/**
 * Notes Ch03 §3.1 and Ch07 §7.2 — the MCP **client**: one function per protocol
 * verb, so the difference between reading a Resource and fetching a Prompt is
 * visible on the page.
 *
 * This module is the host's only door to the server. Nothing above it imports the
 * SDK, which is what makes the rest of `src/host` and all of `src/controllers`
 * testable against a stub — and what keeps the answer to *"what does this
 * application actually do with the protocol?"* down to seven functions.
 *
 * Two details are here because the lecture names them and most clients get them
 * wrong:
 *
 *  · **Pagination.** `resources/list` and `prompts/list` are paged with
 *    `nextCursor`, and a client that ignores it silently sees only the first
 *    page. At demo scale that is invisible; at real scale it is a bug that looks
 *    like missing data (Notes Ch03 §3.9).
 *
 *  · **Two content shapes.** A tool result is `content[]` blocks carrying a
 *    `type` discriminator; resource contents are `{ uri, mimeType, text | blob }`.
 *    They are two different wire contracts, so they get two different extractors
 *    rather than one clever one.
 */

/**
 * The SDK's own return types, named rather than re-declared.
 *
 * Writing these out by hand would be a second copy of the protocol to keep in
 * sync; deriving them means a protocol change shows up as a type error here
 * instead of a runtime surprise in a controller.
 */
export type ListedResources = Awaited<ReturnType<Client["listResources"]>>["resources"];
export type ListedTemplates = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"];
export type ListedPrompts = Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
export type ListedTools = Awaited<ReturnType<Client["listTools"]>>["tools"];
export type RenderedPrompt = Awaited<ReturnType<Client["getPrompt"]>>;
export type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

/** One resource read, flattened to what the application actually uses. */
export interface ResourceBody {
  uri: string;
  mimeType: string;
  text: string;
  chars: number;
}

export interface McpClient {
  /** The escape hatch, for a caller that needs a verb this interface does not wrap. */
  readonly raw: Client;
  /** Every page, followed to exhaustion — never just the first one. */
  listResources(): Promise<{ resources: ListedResources; templates: ListedTemplates }>;
  read(uri: string): Promise<ResourceBody>;
  listPrompts(): Promise<ListedPrompts>;
  getPrompt(name: string, args: Record<string, string>): Promise<RenderedPrompt>;
  listTools(): Promise<ListedTools>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/**
 * A result is `content[]` blocks, never a bare value (Notes Ch03 §3.8).
 *
 * Only `text` blocks are joined: a client that stringifies an image block would
 * put base64 into a prompt, which is a token-budget incident rather than a bug
 * report.
 */
export function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;

  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Resource contents are `{ uri, mimeType, text | blob }` — a *different* shape
 * from a tool's content blocks, which carry a `type` discriminator. Two
 * extractors, because they are two different wire contracts.
 *
 * Both variants are named in the parameter type so the compiler can check that a
 * binary resource is handled rather than silently dropped.
 */
export function resourceText(contents: ReadonlyArray<{ text?: string; blob?: string }>): string {
  return contents
    .map((content) => content.text ?? (content.blob === undefined ? "" : "[binary content]"))
    .join("\n")
    .trim();
}

export async function createMcpClient(options: {
  url: string;
  logger: Logger;
  metrics: Metrics;
}): Promise<McpClient> {
  const { url, logger, metrics } = options;

  const client = new Client({ name: "task-host", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));

  await client.connect(transport);
  logger.info("client.connected", { url });

  /**
   * Follows `nextCursor` until the server stops offering one.
   *
   * Written once as a generic so the three list verbs cannot diverge — the
   * classic bug is a client that paginates `resources/list` and forgets to in
   * `prompts/list`, which only shows up on the day the catalogue grows past one
   * page.
   */
  const drain = async <Item>(
    verb: string,
    page: (cursor: string | undefined) => Promise<{ items: Item[]; nextCursor?: string }>,
  ): Promise<Item[]> => {
    const items: Item[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const result = await page(cursor);
      items.push(...result.items);
      cursor = result.nextCursor;
      pages += 1;

      // A server that returns the same cursor forever would otherwise hang the
      // host. Ten pages is far past any realistic catalogue and still finite.
      if (pages >= 10) {
        logger.warn("client.pagination_capped", { verb, pages, collected: items.length });
        break;
      }
    } while (cursor !== undefined);

    if (pages > 1) {
      logger.debug("client.paginated", { verb, pages, items: items.length });
    }

    return items;
  };

  return {
    raw: client,

    async listResources() {
      const resources = await drain<ListedResources[number]>("resources/list", async (cursor) => {
        const page = await metrics.time("client.listResources", () =>
          client.listResources(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.resources, nextCursor: page.nextCursor };
      });

      const templates = await drain<ListedTemplates[number]>("resources/templates/list", async (cursor) => {
        const page = await metrics.time("client.listResourceTemplates", () =>
          client.listResourceTemplates(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.resourceTemplates, nextCursor: page.nextCursor };
      });

      return { resources, templates };
    },

    async read(uri) {
      const result = await metrics.time("client.readResource", () => client.readResource({ uri }));
      const text = resourceText(result.contents);
      const first = result.contents[0];

      return {
        uri,
        // The declared type, taken from the reply rather than assumed — a host
        // that guesses the MIME type will eventually render JSON as prose.
        mimeType: first?.mimeType ?? "text/plain",
        text,
        chars: text.length,
      };
    },

    async listPrompts() {
      return drain<ListedPrompts[number]>("prompts/list", async (cursor) => {
        const page = await metrics.time("client.listPrompts", () =>
          client.listPrompts(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.prompts, nextCursor: page.nextCursor };
      });
    },

    /**
     * Notes Ch07 §7.3 — this talks to the **MCP server** and returns *messages*.
     *
     * It is not a model call, it does not need an API key, and it is the reason
     * the prompt path is testable offline. The model call happens afterwards, in
     * `host/model.ts`, and keeping them in two files is what makes that
     * impossible to conflate by accident.
     */
    getPrompt: (name, args) =>
      metrics.time("client.getPrompt", () => client.getPrompt({ name, arguments: args })),

    async listTools() {
      return drain<ListedTools[number]>("tools/list", async (cursor) => {
        const page = await metrics.time("client.listTools", () =>
          client.listTools(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.tools, nextCursor: page.nextCursor };
      });
    },

    callTool: (name, args) =>
      metrics.time("client.callTool", () => client.callTool({ name, arguments: args })),

    async close() {
      try {
        await transport.terminateSession();
      } catch {
        // No session was established, so there is nothing to terminate.
      }

      await client.close();
      logger.info("client.closed", { url });
    },
  };
}
```

### Block-by-block

**Block 1 — the derived types (lines 29–41).**

```ts
export type ListedResources = Awaited<ReturnType<Client["listResources"]>>["resources"];
export type ListedTemplates = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"];
export type ListedPrompts = Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
export type ListedTools = Awaited<ReturnType<Client["listTools"]>>["tools"];
export type RenderedPrompt = Awaited<ReturnType<Client["getPrompt"]>>;
export type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;
```

Six type aliases, and the doc comment states the trade:

> The SDK's own return types, **named rather than re-declared**.
>
> Writing these out by hand would be a second copy of the protocol to keep in sync; deriving them means **a protocol
> change shows up as a type error here instead of a runtime surprise in a controller.**

That is the argument, and the mechanism is worth unpacking because the syntax is dense:

```ts
Awaited<ReturnType<Client["listResources"]>>["resources"]
└───┬──┘└────┬─────────┘└────────┬────────┘ └────┬────┘
    │        │                 │                │
  unwrap   the method       the method      index into the
  the      type, as a       name as a       result type to get
  promise  function type     string literal  the array field
```

- **`Client["listResources"]`** — indexed access on the class, giving the *method's type* rather than a value.
- **`ReturnType<…>`** — the method's return type, which is a `Promise<…>`.
- **`Awaited<…>`** — unwraps the promise, giving the result object.
- **`["resources"]`** — the field this codebase actually consumes.

So `ListedResources` is the SDK's own array element type, not a copy. If the SDK changes the shape of a listed
resource, this alias changes with it and any controller that used a removed field fails to compile. **A second copy
would silently keep compiling and fail at runtime** — which is the failure mode being avoided.

Note the *selection* embedded in each alias: `["resources"]`, `["resourceTemplates"]`, `["prompts"]`, `["tools"]`. The
host does not name the whole result object; it names the array inside it, which is what the caller wants. `getPrompt`
and `callTool` keep the whole result, because the host needs more than one field from each.

**Block 2 — `ResourceBody`, the flattened read (lines 43–49).**

```ts
export interface ResourceBody {
  uri: string;
  mimeType: string;
  text: string;
  chars: number;
}
```

*One resource read, flattened to what the application actually uses.* Four fields, and the flattening is the design:
the protocol's `contents` is an **array** of parts (Chapter 15), and this host always reads exactly one. So the array
is unwrapped once, here, and every caller downstream gets a plain body.

`chars: number` is computed at the boundary — `text.length` — so the context budget (Chapter 06) and the metrics
(Chapter 04) do not each recompute it. One place computes the size, and it is the place that has the text.

**Block 3 — `textOf` (lines 64–78).**

```ts
export function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;

  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}
```

*A result is `content[]` blocks, never a bare value* (Ch03 §3.8) — and the doc comment names the reason only `text`
blocks are joined:

> Only `text` blocks are joined: a client that stringifies an image block would put base64 into a prompt, which is a
> **token-budget incident** rather than a bug report.

That is the right framing. An image block is `{ type: "image", data: "<base64>" }`, and a naive extractor that
`JSON.stringify`-ed every block would put hundreds of kilobytes of base64 into the model's context. The budget
(Chapter 06) would then truncate it — so the symptom would be *a prompt mysteriously missing content*, and the cause
would be two layers away.

Filtering on `block.type === "text"` means non-text blocks are **dropped**, not mangled. That is a deliberate choice:
silently dropping an image is imperfect, and it is strictly better than silently destroying the context window. And
because the parameter is `{ content?: unknown }`, the function is callable on anything result-shaped — including the
`{ content: [message.content] }` wrapper the walkthrough builds from a prompt message (Chapter 26).

**Block 4 — `resourceText`, a different extractor for a different contract (lines 80–94).**

```ts
export function resourceText(contents: ReadonlyArray<{ text?: string; blob?: string }>): string {
  return contents
    .map((content) => content.text ?? (content.blob === undefined ? "" : "[binary content]"))
    .join("\n")
    .trim();
}
```

**Two extractors, because they are two different wire contracts** — and the doc comment says so explicitly:

> Resource contents are `{ uri, mimeType, text | blob }` — a *different* shape from a tool's content blocks, which carry
> a `type` discriminator.

So `textOf` discriminates on `type` and `resourceText` discriminates on **which field is present**. Those are genuinely
different protocols and collapsing them into one "clever" extractor would mean guessing which shape arrived.

**The `[binary content]` marker is the interesting line.** A resource may return a base64 `blob` instead of `text`
(Chapter 15's comment on the read callback says so). This host has no binary Resources — all six are text or JSON — but
the *type* names both variants:

> Both variants are named in the parameter type so **the compiler can check that a binary resource is handled rather
> than silently dropped.**

That is a type-level guarantee doing real work. If the parameter were `ReadonlyArray<{ text?: string }>`, a blob
resource would produce `""` — indistinguishable from an empty document. Naming `blob?: string` forces a decision, and
the decision made is to emit a *visible* marker rather than silence. Same principle as Chapter 06's truncation marker:
**a stated limitation beats a silent one.**

The `.trim()` is a small detail with a purpose: it removes the leading/trailing newlines that joining a single-element
array can leave, so a one-part resource body has no stray whitespace. It also means a body that is *entirely*
whitespace becomes `""`, which is the correct reading of it.

**Block 5 — `createMcpClient` and the connection (lines 96–106).**

```ts
export async function createMcpClient(options: {
  url: string;
  logger: Logger;
  metrics: Metrics;
}): Promise<McpClient> {
  const { url, logger, metrics } = options;

  const client = new Client({ name: "task-host", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));

  await client.connect(transport);
  logger.info("client.connected", { url });
```

A factory returning a promise, taking three things: the URL, a logger and a metrics registry. The logger and metrics
are *injected* rather than imported — the same discipline as everywhere else — which is what lets the walkthrough pass
its own `log` and `metrics` so the client's observations appear in the same report (Chapter 26).

**`new StreamableHTTPClientTransport(new URL(url))`** — the transport is constructed explicitly and passed to
`connect`. That is the seam that makes the binding swappable on the *client* side too: an in-process transport would be
constructed here instead, and nothing else would change.

The client identifies itself as `task-host`, which is what appears in the server's session records — so a server
operator can distinguish *this* host from the Inspector or a smoke test.

**`logger.info("client.connected", { url })`** — one line, and it is the first thing in the log stream that proves a
session was established. If `connect` throws, this line never appears, which is why the walkthrough's
`connectWithRetry` (Chapter 26) can poll for it.

**Block 6 — `drain`, the pagination generic (lines 108–143).**

```ts
const drain = async <Item>(
  verb: string,
  page: (cursor: string | undefined) => Promise<{ items: Item[]; nextCursor?: string }>,
): Promise<Item[]> => {
  const items: Item[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const result = await page(cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    pages += 1;

    if (pages >= 10) {
      logger.warn("client.pagination_capped", { verb, pages, collected: items.length });
      break;
    }
  } while (cursor !== undefined);

  if (pages > 1) {
    logger.debug("client.paginated", { verb, pages, items: items.length });
  }

  return items;
};
```

**This is the single most valuable function in the file**, and the doc comment explains why it is generic rather than
repeated:

> Written **once as a generic** so the three list verbs cannot diverge — the classic bug is a client that paginates
> `resources/list` and forgets to in `prompts/list`, which only shows up **on the day the catalogue grows past one
> page**.

That failure mode is worth spelling out. At demo scale every list fits on one page, so a client that ignores
`nextCursor` works perfectly. It breaks on the day the catalogue grows — and it breaks by *silently returning fewer
results*, which looks like "the data is not there" rather than "the client is broken". A generic that all three verbs
call makes the omission impossible.

Four details:

**`do … while (cursor !== undefined)`** — a `do/while`, not a `while`. The first request has no cursor, so the loop must
run at least once. A `while` would need the first call written separately, duplicating the body.

**`page` is a callback, not a verb name.** The generic knows nothing about MCP — it takes a function that produces a
page from a cursor. So the same code serves `resources/list`, `resources/templates/list`, `prompts/list` and
`tools/list` (Chapter 19's `listResources` drains *two* verbs). **The pagination logic is protocol-agnostic**, which is
the right place for it.

**The ten-page cap, and the comment explains the hazard:**

> A server that returns the same cursor forever would otherwise hang the host. Ten pages is far past any realistic
> catalogue and still finite.

This is a **malicious-or-buggy-server defence**, and it is the kind of thing a client must have because the server is
not fully trusted. A server that always returned `nextCursor: "x"` would make `drain` loop forever, and the host would
hang with no error — a denial of service with no attack surface required. The cap converts it into a warning:
`client.pagination_capped` with the verb and how many items were collected.

**`if (pages > 1) logger.debug("client.paginated", …)`** — a debug line only when pagination actually happened. At
demo scale it never fires, so the normal log stream is not cluttered; if a deployment ever paginates, the line appears
and tells you how many pages. **Instrumentation that is silent until it matters.**

**Block 7 — the verbs (lines 145–216).**

`listResources` drains **two** verbs and returns both, because a catalogue has instances and templates and a host
needs both to render a picker:

```ts
async listResources() {
  const resources = await drain<ListedResources[number]>("resources/list", async (cursor) => {
    const page = await metrics.time("client.listResources", () =>
      client.listResources(cursor === undefined ? {} : { cursor }),
    );

    return { items: page.resources, nextCursor: page.nextCursor };
  });

  const templates = await drain<ListedTemplates[number]>("resources/templates/list", async (cursor) => {
    const page = await metrics.time("client.listResourceTemplates", () =>
      client.listResourceTemplates(cursor === undefined ? {} : { cursor }),
    );

    return { items: page.resourceTemplates, nextCursor: page.nextCursor };
  });

  return { resources, templates };
}
```

Three things to notice in each adapter:

**`cursor === undefined ? {} : { cursor }`** — the SDK's parameter is `{ cursor?: string }`, and passing
`{ cursor: undefined }` is *not* the same as omitting it for some HTTP serialisation paths. So the ternary is not
defensive style; it is what keeps the first request's query string clean.

**`metrics.time("client.listResources", () => client.listResources(...))`** — the timing wrapper from Chapter 04,
which measures to **settlement** because the returned value is a promise. That is why the lifecycle's
`client.listResources.ms` reports a real round trip rather than `0`.

**`ListedResources[number]`** — indexing the array type by `number` gives its element type. So `drain` is instantiated
with the SDK's own element type, and the returned array is typed exactly as the alias says.

`read` flattens the result and, crucially, takes the MIME type from the reply:

```ts
async read(uri) {
  const result = await metrics.time("client.readResource", () => client.readResource({ uri }));
  const text = resourceText(result.contents);
  const first = result.contents[0];

  return {
    uri,
    mimeType: first?.mimeType ?? "text/plain",
    text,
    chars: text.length,
  };
}
```

**The comment on `mimeType` is the design:** *The declared type, taken from the reply rather than assumed — a host that
guesses the MIME type will eventually render JSON as prose.* Chapter 08 established that MIME type is a contract; this
is the consumer honouring it. A host that hard-coded `text/plain` for prose Resources and `application/json` for
structured ones would be duplicating the descriptor table — and would break the first time a Resource changed its type.

The `?? "text/plain"` fallback handles a reply with no `contents` (or an empty array): `first` is `undefined`, and the
fallback is the least surprising type. And `chars: text.length` computes the size once, here.

`getPrompt` carries a comment that is really the chapter's thesis:

```ts
/**
 * Notes Ch07 §7.3 — this talks to the **MCP server** and returns *messages*.
 *
 * It is not a model call, it does not need an API key, and it is the reason
 * the prompt path is testable offline. The model call happens afterwards, in
 * `host/model.ts`, and keeping them in two files is what makes that
 * impossible to conflate by accident.
 */
getPrompt: (name, args) =>
  metrics.time("client.getPrompt", () => client.getPrompt({ name, arguments: args })),
```

*Keeping them in two files is what makes that impossible to conflate by accident* — that is the structural version of
Chapter 16's "no model in the server". Here it is the *host* side: `getPrompt` is in `client.ts`, the model call is in
`model.ts`, and no file does both.

`callTool` and `listPrompts` follow the same shapes, and `listTools` drains with the same generic — so the tool listing
is paginated too, even though four tools fit on one page. **Correct for the scale you have, not the scale you have
today.**

**Block 8 — `close` (lines 217–226).**

```ts
async close() {
  try {
    await transport.terminateSession();
  } catch {
    // No session was established, so there is nothing to terminate.
  }

  await client.close();
  logger.info("client.closed", { url });
}
```

The `try/catch` around `terminateSession` is a deliberate swallow, and the comment justifies it: *no session was
established, so there is nothing to terminate.* That happens in the walkthrough's `ensureServer` probe (Chapter 26),
which constructs a client specifically to test reachability and may fail to connect — in which case `close` is called
on a client that never established a session.

**An empty `catch` is normally a smell; here it is correct**, and the reason is that the failure carries no information
the caller can act on. Closing a client that was never connected *should* succeed as far as the caller is concerned —
the desired end state (no session, no resources) already holds. Contrast the alternative: rethrowing would mean every
`close` call site needed to handle a failure that has no remedy.

`client.close()` then runs unconditionally, and the `client.closed` log line is emitted last — so the log stream shows
one `client.connected` at the start and one `client.closed` at the end, which is how the lifecycle's output brackets the
session.

---

## Run / verify

### 1. The session, bracketed in the log

```bash
MCP_LOG_LEVEL=debug npm run lifecycle 2>&1 >/dev/null | grep -E 'client\.(connected|closed|paginated|pagination_capped)'
```

```json
{"ts":"…","level":"info","event":"client.connected","host":"lifecycle","url":"http://127.0.0.1:8081/mcp"}
{"ts":"…","level":"info","event":"client.closed","host":"lifecycle","url":"http://127.0.0.1:8081/mcp"}
```

Two lines, one session. Note `"host":"lifecycle"` on both — that binding comes from `createLogger` at the walkthrough's
module scope (Chapter 03), which is why the client's own lines are distinguishable from the server's in a stream that
contains both processes.

**And note what is *absent*: no `client.paginated`, no `client.pagination_capped`.** Both are conditional — the first
only when more than one page was fetched, the second only when the cap fired — and at this scale neither happens. That
is the point of gating them: a normal run's log stream stays clean, and the lines appear only when they carry
information.

### 2. The pagination generic, and the cap

The cap is easiest to demonstrate by reading the condition rather than by provoking it, because provoking it needs a
misbehaving server:

```ts
if (pages >= 10) {
  logger.warn("client.pagination_capped", { verb, pages, collected: items.length });
  break;
}
```

A server that returned `nextCursor: "x"` forever would make the loop unbounded; this breaks at ten pages and warns
with the verb, the page count and how many items were collected. **A client that trusts a server's cursor to
terminate is a client that can be hung by a server** — and the fix is four lines.

To see the *other* branch, raise the catalogue past one page. The server's registrars would need to return a
`nextCursor`, which the SDK does not do for a catalogue this small — so in practice this code path is correct and
exercised only by a larger deployment. That is the honest state of it: written once, generic across four verbs, and
currently a no-op.

### 3. The verbs, and their measured latency

From the lifecycle's metrics (Chapter 04), every verb this client wraps reports a real round trip:

```text
client.callTool.ms.avg                   64
client.getPrompt.ms.avg                  8
client.listPrompts.ms.avg                15
client.listResources.ms.avg              11
client.listResourceTemplates.ms.avg      10
client.listTools.ms.avg                  40
client.readResource.ms.avg               9
client.readResource.ms.count             10
client.readResource.ms.max               12
```

Seven verbs wrapped, seven metric families — because each call site passes through `metrics.time`. The
`readResource.ms.count: 10` is the walkthrough's ten reads, and `max: 12` against `avg: 9` shows the spread across
them.

That the numbers are *not* zero is Chapter 04's fix (measuring promise settlement rather than promise construction) —
and it is what makes these metrics useful rather than decorative.

### 4. The two extractors, and the shapes they handle

The distinction is testable in one line each:

```ts
// a tool result: blocks with a `type` discriminator
textOf({ content: [{ type: "text", text: "Open tasks: 3" }, { type: "image", data: "…base64…" }] })
//   → "Open tasks: 3"          the image block is dropped, not stringified

// a resource read: parts with `text | blob`
resourceText([{ uri: "task://backlog", text: "Open tasks: 3" }])
//   → "Open tasks: 3"

resourceText([{ uri: "doc://x", blob: "…base64…" }])
//   → "[binary content]"       a visible marker, not silence
```

**Two shapes, two extractors, and neither guesses.** The first discriminates on `type`, the second on which field is
present — because those are genuinely different wire contracts (Ch03 §3.8). And both handle the awkward case *visibly*:
an image block is dropped rather than serialised into the prompt, and a blob is marked rather than silently emptied.

### 5. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

The six derived aliases are what the typecheck is really validating here. Change a field name in the SDK's return type
and this file fails to compile — which is the intended behaviour, and much better than a controller failing at runtime.

---

## Checkpoint

1. **Why wrap the SDK at all rather than call `Client` directly?**
   So *"what does this application do with the protocol?"* is answerable by reading one seven-method interface, and so
   nothing above `client.ts` imports the SDK. The `raw` field remains as a documented escape hatch.

2. **Why derive the result types instead of declaring them?**
   A hand-written copy would be a second version of the protocol to keep in sync — and a protocol change would then
   compile fine and fail at runtime. Deriving means the SDK's change becomes a **compile error** in one place.

3. **Why is `drain` generic rather than three pagination loops?**
   Because the classic bug is a client that paginates one list verb and forgets another — which only shows up the day
   the catalogue grows past one page, and shows up as *missing data* rather than as an error.

4. **What is the ten-page cap for?**
   A server that returns the same cursor forever would hang the host — a denial of service requiring no attack surface.
   The cap breaks the loop and warns with the verb, page count and items collected.

5. **Why does `read` take the MIME type from the reply?**
   Because MIME type is a contract (Ch03 §3.8), and a host that guesses it will eventually render JSON as prose. Taking
   it from the reply also means the host does not duplicate the descriptor table.

6. **Why two extractors instead of one clever one?**
   Because a tool result is `content[]` blocks discriminated by `type`, and resource contents are `{ uri, mimeType,
   text | blob }`. Two different wire contracts; one extractor would have to guess which arrived.

7. **Why is `textOf` filtering on `type === "text"` important?**
   Because a naive extractor would put an image block's base64 into the model's context — a token-budget incident. The
   budget would then truncate it, so the symptom (missing content) would be two layers from the cause.

8. **Why does `close` swallow the `terminateSession` failure?**
   Because closing a client that never established a session should succeed as far as the caller is concerned — the
   desired end state already holds. Rethrowing would force every call site to handle a failure with no remedy.

9. **Why does the client pass `{}` rather than `{ cursor: undefined }` on the first page?**
   Because they are not equivalent through the SDK's serialisation path. Omitting the key keeps the first request's
   query string clean.

---

**[← Chapter 18: The MCP Server over HTTP](./18_Entry_Mcp_Server_Http.md)** · **[Chapter 20: Host Policy →](./20_Host_Policy.md)**

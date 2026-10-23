# Chapter 04 — Resources: Static, Dynamic, Templated

> **Goal of this chapter:** register five Resources that cover all three shapes the lecture
> describes, and learn the exact anatomy of each — **name, URI, description, MIME type, content**.
> This is the file Lecture 15 spends most of its time on.
>
> **Lecture chapters:** [03 — Resource Discovery, Reading and Anatomy](../../../notes/03_Resource_Discovery_Reading_and_Anatomy.md)
> and [04 — Building Resources: Static, Dynamic and Templated](../../../notes/04_Building_Resources_Static_Dynamic_and_Templated.md).

---

## 4.1 File details

| | |
|---|---|
| **Path** | `src/resources/resources.ts` |
| **Purpose** | declare the Resource catalogue: three fixed URIs plus two templates |
| **Imports** | `ResourceTemplate`, `type McpServer` from `@modelcontextprotocol/server`; `taskScheme`, `userScheme` from config; the four text views from `taskService` |
| **Exports** | `registerResources(server)` |
| **Depends on** | `src/config/config.ts`, `src/services/taskService.ts` |
| **Called by** | `src/server/server.ts` |
| **Implements** | Lecture 03 (discovery, reading, anatomy, URI ≠ URL), Lecture 04 (static / dynamic / templated) |

## 4.2 Commands

Resources are registered on the server, so you need a server running. The quickest way to see
all five:

```bash
npm run lifecycle
```

or, with the server running in another terminal:

```bash
npx @modelcontextprotocol/inspector --url http://127.0.0.1:8081/mcp
```

---

## 4.3 Full file

**Path:** `src/resources/resources.ts`

```ts
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";

import { taskScheme, userScheme } from "../config/config.js";
import { backlogText, profileText, projectText, summaryText } from "../services/taskService.js";

/**
 * Chapter 03/04 — Resources: addressable context, controlled by the APPLICATION.
 *
 * Every registration below is one of the three shapes Chapter 04 describes:
 *
 *   STATIC     a fixed URI whose content never changes
 *   DYNAMIC    a fixed URI whose content is recomputed on every read
 *   TEMPLATED  one definition that serves a whole family of URIs
 *
 * Reading any of these executes nothing — a Resource is *know*, never *do*.
 */

/** Chapter 04 — the STATIC content. It lives here because it is the Resource. */
const guidelines = `Task Management Guidelines:

1. Deep work tasks should preferably be done before 12 PM.
2. Meetings should preferably be scheduled after 2 PM.
3. Urgent tasks should be completed on the same day.
4. Keep a maximum of three high-priority tasks per day.
5. Complete high-priority tasks before low-priority tasks.`;

export function registerResources(server: McpServer): void {
  /* ── 1 · STATIC — same URI, same bytes, every time ────────────────────── */

  server.registerResource(
    "guidelines",
    `${taskScheme}://guidelines`,
    {
      title: "Task management guidelines",
      // Chapter 03 §3.6 — the description is what the application ranks when it
      // chooses a Resource, so it is written for a chooser, not for a human.
      description:
        "Company rules for prioritising and scheduling tasks. Read this before planning anyone's day.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: guidelines }],
    }),
  );

  /* ── 2 · DYNAMIC — same URI, content recomputed on every `resources/read` ─ */

  server.registerResource(
    "backlog",
    `${taskScheme}://backlog`,
    {
      title: "Open backlog",
      description:
        "Every task that is not done yet, with its priority, project and owner. Use this when the user asks what is on their plate.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: backlogText() }],
    }),
  );

  server.registerResource(
    "summary",
    `${taskScheme}://summary`,
    {
      title: "Workload summary",
      description:
        "Counts of open tasks by priority, plus the projects they belong to. Use this to answer questions like 'how busy am I?'.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: summaryText() }],
    }),
  );

  /* ── 3 · TEMPLATED — one definition, a whole family of URIs ───────────── */

  server.registerResource(
    "project",
    new ResourceTemplate(`${taskScheme}://projects/{projectId}`, { list: undefined }),
    {
      title: "Project brief",
      description:
        "Every task in one project. Replace {projectId} with a project such as fde or media.",
      mimeType: "text/plain",
    },
    // A template callback receives the resolved URI *and* the extracted
    // variables — that is the difference from the static callbacks above.
    async (uri, variables) => {
      const projectId = String(variables.projectId);

      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text: projectText(projectId) }],
      };
    },
  );

  server.registerResource(
    "user-profile",
    new ResourceTemplate(`${userScheme}://{userId}/profile`, { list: undefined }),
    {
      title: "User profile",
      description: "A person's profile and open workload. Replace {userId} with an id such as 123.",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const userId = String(variables.userId);

      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text: profileText(userId) }],
      };
    },
  );
}
```

---

## 4.4 Block-by-block explanation

### Block 1 — the imports

```ts
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { taskScheme, userScheme } from "../config/config.js";
import { backlogText, profileText, projectText, summaryText } from "../services/taskService.js";
```

- `ResourceTemplate` is a **value** (a class), so it is imported normally.
  `McpServer` is used only as a **type**, so it is imported with `type` — which means it is
  erased at compile time and adds nothing to the runtime bundle.
- Note what is **not** imported: `Client`, `openai`, `node:http`, or anything from `tools/` or
  `prompts/`. A Resource registration only needs the server object and its own data.
- The `.js` extensions are required by `NodeNext` resolution (Chapter 01 §1.7).

### Block 2 — the static content lives in the Resource file

```ts
const guidelines = `Task Management Guidelines:

1. Deep work tasks should preferably be done before 12 PM.
2. Meetings should preferably be scheduled after 2 PM.
3. Urgent tasks should be completed on the same day.
4. Keep a maximum of three high-priority tasks per day.
5. Complete high-priority tasks before low-priority tasks.`;
```

- **Why here and not in `taskService.ts`?** Because this text *is* the Resource. It is content
  with no computation behind it, so it belongs next to the URI that exposes it. Computed content
  (backlog, summary, project, profile) lives in `taskService.ts` because it is derived from data.
- The rule of thumb: **static content → the Resource file; derived content → the service.**
- In the lecture's board this text is `company://coding-guidelines`. Here it is
  `task://guidelines` — same idea, different domain.

### Block 3 — the registration signature

Every call in this file has the same four arguments:

```ts
server.registerResource(
  name,        // a short identifier the client sees in resources/list
  uriOrTemplate, // a string URI, or a ResourceTemplate
  metadata,    // { title, description, mimeType }
  readCallback // (uri) => { contents: [...] }   ← or (uri, variables) for templates
);
```

- **`name`** — `"guidelines"`, `"backlog"`, … It is the programmatic handle; the `title` in
  metadata is the human label. The lecture's anatomy list (name, URI, description, MIME type,
  content) maps onto these arguments one-for-one.
- **`uriOrTemplate`** — the single argument that decides *which shape* you are registering.
  A `string` → static/dynamic. A `ResourceTemplate` → templated.
- **`metadata`** — `description` is the important field, and Chapter 03 §3.6 explains why: it is
  what the application ranks against when it *chooses* a Resource (see Chapter 05).
- **`readCallback`** — a function that is **only called on `resources/read`**, never at
  registration time. That is why dynamic content is always fresh.

### Block 4 — the static Resource

```ts
server.registerResource(
  "guidelines",
  `${taskScheme}://guidelines`,
  {
    title: "Task management guidelines",
    description:
      "Company rules for prioritising and scheduling tasks. Read this before planning anyone's day.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: guidelines }],
  }),
);
```

- `` `${taskScheme}://guidelines` `` evaluates to `"task://guidelines"`. Building it from the
  constant is what lets Chapter 02 change the scheme in one place.
- The callback takes **only `uri`** — there are no variables to extract, because there are no
  braces in the URI. That is the structural difference between a static and a templated Resource.
- `uri.href` echoes the requested URI back. Using `uri.href` rather than re-typing the string
  guarantees the response matches the request exactly — including any normalisation the
  protocol layer applied.
- The return value is `{ contents: [...] }` — a **`contents` array**, not a single object.
  It is an array because one read may return several blocks (for example a summary plus its
  source), and because a `ResourceLink` may point at further Resources.
- `async` even though nothing is awaited. It keeps every callback in the file the same shape,
  and it means a future database call needs no signature change.

### Block 5 — the two dynamic Resources

```ts
server.registerResource(
  "backlog",
  `${taskScheme}://backlog`,
  {
    title: "Open backlog",
    description:
      "Every task that is not done yet, with its priority, project and owner. Use this when the user asks what is on their plate.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: backlogText() }],
  }),
);
```

- **Structurally identical to Block 4.** Same string URI, same single-`uri` callback. The *only*
  difference is that `guidelines` is a constant and `backlogText()` is a function call.
- **That one character difference is the entire static-vs-dynamic distinction.** There is no
  `dynamic: true` flag, no refresh interval, no cache directive. The protocol does not need to
  know — it just calls your callback, and your callback decides how fresh to be.
- The description is written as an *instruction to a chooser*: *"Use this when the user asks what
  is on their plate."* Compare that with a description written for a human, like
  *"The backlog"*. Chapter 05 shows the first one actually gets picked.

```ts
server.registerResource(
  "summary",
  `${taskScheme}://summary`,
  {
    title: "Workload summary",
    description:
      "Counts of open tasks by priority, plus the projects they belong to. Use this to answer questions like 'how busy am I?'.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: summaryText() }],
  }),
);
```

- A **third** Resource over the same underlying data. Nothing is duplicated: `summaryText()` and
  `backlogText()` are two views of one array (Chapter 03).
- **This is the design lesson of the chapter.** If you only had one Resource, a model asked
  *"how busy am I?"* would receive the whole backlog and have to count. Two Resources let the
  application hand over the *right* granularity — which is what Chapter 05 is about.

### Block 6 — the first template

```ts
server.registerResource(
  "project",
  new ResourceTemplate(`${taskScheme}://projects/{projectId}`, { list: undefined }),
  {
    title: "Project brief",
    description:
      "Every task in one project. Replace {projectId} with a project such as fde or media.",
    mimeType: "text/plain",
  },
  async (uri, variables) => {
    const projectId = String(variables.projectId);

    return {
      contents: [{ uri: uri.href, mimeType: "text/plain", text: projectText(projectId) }],
    };
  },
);
```

- `new ResourceTemplate("task://projects/{projectId}", { list: undefined })` — the `{projectId}`
  braces are **URI template** syntax, the same idea as an HTTP route parameter. One registration
  now answers every URI that matches the pattern: `task://projects/fde`, `task://projects/media`,
  and any project that does not exist yet.
- **Why `{ list: undefined }`?** The template constructor requires a `list` callback that
  enumerates every Resource matching the pattern. Passing `undefined` explicitly says *"this
  template cannot be enumerated"* — and the SDK requires the key to be present so you cannot
  forget it by accident. This is why `task://projects/fde` appears under
  `resources/templates/list` and **not** under `resources/list`.
- **The callback now takes two parameters:**

  ```ts
  async (uri, variables) => { … }
  ```

  `uri` is the resolved `URL` (`task://projects/fde`). `variables` is
  `Record<string, string | string[]>` — here `{ projectId: "fde" }`. **That second parameter is
  the whole point of a template:** the argument travels in the URI and arrives as data.
- `String(variables.projectId)` is a **type guard, not a conversion you expect to need.** The
  declared type is `string | string[]` (because a template may repeat a variable), and
  `projectText()` wants a `string`. `String(...)` narrows it, and it also normalises the
  theoretical array case into something printable.
- Compare the two callbacks side by side:

  | | static / dynamic | templated |
  |---|---|---|
  | second argument | `uri` only | `uri, variables` |
  | appears in | `resources/list` | `resources/templates/list` |
  | answers | exactly one URI | a family of URIs |

### Block 7 — the second template (the board's example)

```ts
server.registerResource(
  "user-profile",
  new ResourceTemplate(`${userScheme}://{userId}/profile`, { list: undefined }),
  {
    title: "User profile",
    description: "A person's profile and open workload. Replace {userId} with an id such as 123.",
    mimeType: "text/plain",
  },
  async (uri, variables) => {
    const userId = String(variables.userId);

    return {
      contents: [{ uri: uri.href, mimeType: "text/plain", text: profileText(userId) }],
    };
  },
);
```

- This is `user://123/profile` from the lecture board, where it was backed by MySQL. Here the
  data comes from `profileText()` (Chapter 03) — the same shape, without inventing a database.
- The variable sits **in the middle** of the path (`{userId}` before `/profile`), which proves
  the template is a pattern and not just a prefix. `task://projects/{projectId}` put it at the
  end; both work.
- The description tells the *chooser* how to fill the variable: *"Replace {userId} with an id
  such as 123."* Without that, a client that wanted to read a profile would have to guess the id
  format.
- **Five Resources, two templates.** Before templating you would need one registration per
  project and per user. With templates, the catalogue stays five lines long no matter how many
  projects or people exist — Chapter 04's *"template instead of enumerating"*.

---

## 4.5 The catalogue this file produces

| # | Kind | URI | Content source | Appears in |
|---|---|---|---|---|
| 1 | **static** | `task://guidelines` | the `guidelines` constant | `resources/list` |
| 2 | **dynamic** | `task://backlog` | `backlogText()` | `resources/list` |
| 3 | **dynamic** | `task://summary` | `summaryText()` | `resources/list` |
| 4 | **templated** | `task://projects/{projectId}` | `projectText(projectId)` | `resources/templates/list` |
| 5 | **templated** | `user://{userId}/profile` | `profileText(userId)` | `resources/templates/list` |

### Anatomy, mapped to the code

Lecture 03 lists five parts of a Resource. Here is where each one is written:

| Part | Where it is in the code |
|---|---|
| **name** | the first argument — `"guidelines"`, `"backlog"`, `"project"`, `"user-profile"` |
| **URI** | the second argument — the string or the `ResourceTemplate` |
| **description** | `metadata.description` — written *for the chooser*, see Chapter 05 |
| **MIME type** | `metadata.mimeType` — `"text/plain"` here |
| **content** | the `contents[0].text` returned by the read callback |

The extra field, `title`, is the human label a UI shows in a menu. `name` is what code uses.

---

## 4.6 Why `task://` and not `https://` — the practical reason

Chapter 02 introduced the schemes; here is what actually goes wrong if you get it wrong.

If you registered `https://example.com/guidelines`, a client would be entitled to conclude:
*"I can fetch this myself with `fetch()`"* — and it might, bypassing your server, your
authorisation and your freshness logic entirely. It would also be free to cache it as an ordinary
web document.

With `task://guidelines` the client knows two things immediately: **only the server can resolve
this**, and **the only way to read it is `resources/read`**. The address is honest, so the client
behaves correctly without any extra negotiation.

That is Lecture 03 §3.5 in one paragraph: *a URI is an identifier, not a locator.*

---

## 4.7 Run / verify

```bash
npm run lifecycle
```

Steps 1–4 of the output are this file working:

```text
1. resources/list — discovery, not consumption
   task://guidelines
   task://backlog
   task://summary
   task://projects/{projectId}   (template)
   user://{userId}/profile   (template)

2. resources/read task://guidelines — a STATIC Resource
   Task Management Guidelines:
   1. Deep work tasks should preferably be done before 12 PM.
   ...

3. resources/read task://projects/fde — a TEMPLATED Resource, one definition
   Project: fde
   Tasks: 2

   - [open] Write MCP notes
   - [open] Review pull request

4. resources/read user://123/profile — a second template, same shape
   User: 123
   Open tasks: 2 of 2

   - [open] Write MCP notes
   - [open] Review pull request
```

Notice that steps 3 and 4 read **URIs that were never registered individually** — `fde` and
`123` were invented at call time and the templates matched them.

To prove a dynamic Resource is really dynamic, read it twice with a task created in between:

```bash
# terminal 1
npm run server

# terminal 2
curl -s 'http://127.0.0.1:8080/read?uri=task://summary'   # needs: npm run host
```

---

## 4.8 Checkpoint

1. **Which single argument decides whether a Resource is static/dynamic or templated?** → the
   second one: a `string` URI, or a `ResourceTemplate`.
2. **What is the *only* code difference between a static and a dynamic Resource?** → a constant
   (`guidelines`) versus a function call (`backlogText()`).
3. **Why does `task://projects/fde` not appear in `resources/list`?** → templates are listed
   separately, under `resources/templates/list`; `resources/list` returns fixed URIs only.
4. **Where does the template variable arrive?** → as the callback's second parameter,
   `variables.projectId` / `variables.userId`.
5. **Does reading a Resource change anything?** → no. Every callback here is a pure read.

**Next:** [Chapter 05 — Resource Selection: How the App Chooses](./05_Resource_Selection_How_the_App_Chooses.md)




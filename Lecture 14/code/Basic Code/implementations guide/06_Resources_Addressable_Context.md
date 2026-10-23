# Chapter 06 — Resources: Addressable Context

> **Goal of this chapter:** read the file that exposes *knowledge* rather than *actions*.
> A **Resource** is **addressable context**: the *application* decides to read it, the content is
> read-only, and reading it **executes nothing**.
>
> **Lecture chapter:** [06 — Resources and Prompts](../../../notes/06_Resources_and_Prompts.md)
> (§6.2 addressable context, §6.3 resource operations, §6.4 contents).

---

## 6.1 File details

| Property | Value |
|---|---|
| **Path** | `src/resources/resources.ts` |
| **Layer** | MCP primitive — **Resources** (*know*) |
| **Purpose** | expose company policies as read-only, URI-addressable context |
| **Imports** | `McpServer` (type-only), `policyScheme` (config) |
| **Exports** | `registerResources(server)` |
| **Imported by** | `src/server/server.ts` |
| **Protocol methods** | `resources/list` (discovery), `resources/read` (retrieval) |
| **Lecture sections** | 06 §6.2–§6.4 |

### Tool vs Resource, in one line

| | Tool (Chapter 05) | Resource (this chapter) |
|---|---|---|
| Intent | **do** | **know** |
| Driven by | the **model** | the **application** |
| Methods | `tools/list`, `tools/call` | `resources/list`, `resources/read` |
| Side effects | possible | **none** — reading changes nothing |

---

## 6.2 Commands

```bash
cd "Lecture 14/code/Basic Code"

npm run client      # prints: 4. resources/list -> company://policies/return-policy, company://policies/refund-policy

# Inspect the raw protocol: ask the server for its resource list over stdio
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}' | npm run server --silent
```

---

## 6.3 Full file

**Path:** `src/resources/resources.ts`

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { policyScheme } from "../config/config.js";

/**
 * Chapter 06 §6.2–6.4 — Resources: addressable context.
 *
 * A Resource is *know*, not *do*: the application (never the model) decides to
 * read it, the content is read-only, and the URI is what makes it addressable.
 * Reading a resource executes nothing.
 */
const policies: Record<string, string> = {
  "return-policy": "Returns are accepted within 30 days of delivery. Electronics must include the original packaging.",
  "refund-policy": "Refunds are issued to the original payment method within 5 business days of approval.",
};

export function registerResources(server: McpServer): void {
  for (const [name, text] of Object.entries(policies)) {
    const uri = `${policyScheme}://policies/${name}`;

    server.registerResource(
      name,
      uri,
      {
        title: name.replace(/-/g, " "),
        description: `Company policy exposed as addressable context at ${uri}`,
        mimeType: "text/plain",
      },
      // `resources/read` — the client retrieves the content by URI. Text
      // resources use `text`; binary ones would use a base64 `blob`.
      async (readUri) => ({
        contents: [{ uri: readUri.href, mimeType: "text/plain", text }],
      }),
    );
  }
}
```

---

## 6.4 Block-by-block explanation

### Block 1 — the imports

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { policyScheme } from "../config/config.js";
```

**What it does:** pulls in the server type and the URI scheme.

**How it works:**
- `import type { McpServer }` — type-only, erased at compile time; this file only needs the type.
- `policyScheme` comes from Chapter 02, so the `company` scheme is defined in exactly one place. If
  you renamed the scheme, every resource URI would change with it.

### Block 2 — the content (the "know" data)

```ts
const policies: Record<string, string> = {
  "return-policy": "Returns are accepted within 30 days of delivery. Electronics must include the original packaging.",
  "refund-policy": "Refunds are issued to the original payment method within 5 business days of approval.",
};
```

**What it does:** holds the actual policy text, keyed by a short name.

**How it works:**
- `Record<string, string>` types it as "an object whose keys are strings and values are strings".
- Each key (`return-policy`) becomes both the resource *name* and the last path segment of its
  *URI*; each value is the *content* the client receives.
- It is a plain constant — reading a resource just reads this object. **No function runs, nothing
  mutates.** That is what makes a Resource safe, application-driven context.

### Block 3 — register each policy as a resource (the loop)

```ts
export function registerResources(server: McpServer): void {
  for (const [name, text] of Object.entries(policies)) {
    const uri = `${policyScheme}://policies/${name}`;
```

**What it does:** iterates the `policies` record and, for each entry, builds its URI and registers a
resource.

**How it works:**
- `Object.entries(policies)` turns the object into `[key, value]` pairs:
  `["return-policy", "Returns are accepted…"]`, `["refund-policy", "Refunds are issued…"]`.
- `for (const [name, text] of …)` **destructures** each pair into `name` and `text`.
- `` `${policyScheme}://policies/${name}` `` builds the URI, e.g.
  `company://policies/return-policy`. The path segment `policies/` is a namespace; the last segment
  is the identity of the specific document.
- **Why a loop?** Adding a third policy means adding one line to `policies` — no new registration
  code. The data drives the registration.

### Block 4 — `registerResource` and the reader

```ts
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
}
```

**What it does:** registers one resource: its name, its URI, its metadata, and the function that
returns its content when the client reads it.

**How it works, argument by argument:**
- **`name`** — the resource's short identifier (`return-policy`). Used by `resources/list`.
- **`uri`** — the **address**. This is the resource's identity: the client stores and requests it by
  URI, not by name. `resources/read` takes this exact URI.
- **the metadata object:**
  - `title: name.replace(/-/g, " ")` — turns `return-policy` into `return policy` for display.
    `.replace(/-/g, " ")` replaces **all** hyphens (the `g` flag), not just the first.
  - `description` — a human hint that names the URI.
  - `mimeType: "text/plain"` — declares the content type so the client can render it correctly.
- **the reader `async (readUri) => ({ contents: [...] })`** — this runs on `resources/read`:
  - The SDK passes the requested URI back in (`readUri`), and we echo its `href` so the response is
    self-identifying.
  - `contents` is an **array of content blocks**. Text resources use a `text` field; binary
    resources would use a base64 `blob` field instead (§6.4). Here every policy is plain text, so
    each read returns exactly one block — which is why the client prints `1 content block(s)`.
  - Note the closure: `text` is captured from the loop, so each registered reader returns *its own*
    policy text. (Because it is a `const` per iteration, there is no classic loop-variable capture bug.)

---

## 6.5 Run / verify

```bash
cd "Lecture 14/code/Basic Code"
npm run client
```

Relevant output:

```text
4. resources/list -> company://policies/return-policy, company://policies/refund-policy
   resources/read company://policies/return-policy -> 1 content block(s)
```

And the raw protocol (`resources/list`) returns the full metadata for each resource:

```json
{"result":{"resources":[
  {"uri":"company://policies/return-policy","name":"return-policy","title":"return policy",
   "description":"Company policy exposed as addressable context at company://policies/return-policy","mimeType":"text/plain"},
  {"uri":"company://policies/refund-policy","name":"refund-policy","title":"refund policy",
   "description":"Company policy exposed as addressable context at company://policies/refund-policy","mimeType":"text/plain"}
]},"jsonrpc":"2.0","id":2}
```

---

## 6.6 Checkpoint

1. **Who drives a Resource — model, application or user?** The **application**. The model never asked
   for these policies in the demo; the client read them.
2. **What makes a resource *addressable*?** Its **URI** (`company://policies/return-policy`) — the
   client requests content by URI, not by name.
3. **What does reading a resource change?** Nothing. There are no side effects, which is why
   Resources are safe to attach as context.

**Next:** [Chapter 07 — Prompts: Reusable Instructions](./07_Prompts_Reusable_Instructions.md)


# Chapter 17: Host — The Lifecycle

> **Chapter goal:** Run the whole machine — handshake → discovery → policy → consent → invocation →
> result — and see which step is probabilistic and which is ordinary software.

---

## 17.1 File details

| | |
| :--- | :--- |
| **Path** | `src/host/client.ts` |
| **Layer** | host (imports the MCP *client* SDK, `config/env`, `core/logger`, `host/audit`, `host/policy`) |
| **Purpose** | The host: spawn the server over stdio, negotiate, discover, apply policy, gate consent, invoke with annotation-driven retry, then read resources, get a prompt, and print the audit trail |
| **Imports** | `node:perf_hooks`, `node:url`, `Client`, `getDefaultEnvironment`/`StdioClientTransport`, `env`, `createLogger`, `createAuditLog`, `createHostPolicy` + types |
| **Exports** | none — it is a program |
| **Consumed by** | `npm run host` |
| **Lecture sections** | [03 — MCP vs tool calling](../../../notes/03_MCP_vs_Tool_Calling_Complementary_Layers.md), [04 — Host, Client, Server](../../../notes/04_Host_Client_Server_Architecture.md), [07 — The tool lifecycle](../../../notes/07_Discovery_Invocation_and_Lifecycle.md) |

### Commands

```bash
cd "Lecture 14/code/Production Code"
npm run host
```

---

## 17.2 Full file

```ts
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { env } from "../config/env.js";
import { createLogger } from "../core/logger.js";
import { createAuditLog } from "./audit.js";
import { createHostPolicy, type ConsentHandler, type DiscoveredTool, type HostPolicy } from "./policy.js";

/**
 * Chapter 04 — Host, Client and Server.
 *
 * This process is the **host**: it owns the conversation, the policy and the
 * user experience, and it spawns exactly one MCP **client** for exactly one
 * server (the 1:1 rule). The server is the capability provider from
 * `src/index.ts`, and it knows nothing about this file.
 *
 * Chapter 07 — the lifecycle runs top to bottom: handshake → discovery →
 * selection → consent → invocation → result. Note which step is probabilistic
 * (only the selection) and which are ordinary, testable software (everything
 * else).
 */

const log = createLogger(env.MCP_LOG_LEVEL, { host: "task-host" });
const audit = createAuditLog(log);

/**
 * The identity every audit record is attributed to. It comes from the session —
 * **never from the model**, because a model-authored identity is a privilege
 * escalation waiting to happen (Chapter 03).
 */
const ACTOR = "user:demo";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Chapter 05 §5.6 — a result is `content[]` blocks, never a bare value. */
function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

/**
 * Resource contents are `{ uri, mimeType, text | blob }` — a *different* shape
 * from a tool's content blocks, which carry a `type` discriminator. Two
 * extractors, because they are two different wire contracts.
 *
 * Both variants are named in the parameter type so the compiler can check that
 * a binary resource is handled rather than silently dropped.
 */
function resourceText(contents: ReadonlyArray<{ text?: string; blob?: string }>): string {
  return contents
    .map((content) => content.text ?? (content.blob === undefined ? "" : "[binary content]"))
    .join(" ")
    .trim();
}

function clip(value: string, max = 100): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Chapter 08 — least privilege, applied to the process environment.
 *
 * The stdio transport does **not** inherit this process's environment. With no
 * `env` option it passes `getDefaultEnvironment()`: a small whitelist (PATH,
 * HOME, SHELL, …) that a child process genuinely needs.
 *
 * That default is the right one. A host's environment holds its model
 * credentials, and a capability provider has no business reading them — so the
 * server's configuration is forwarded **explicitly**, one variable at a time,
 * and nothing else crosses the process boundary.
 */
function serverEnvironment(): Record<string, string> {
  const forwarded: Record<string, string> = { ...getDefaultEnvironment() };

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("MCP_") && value !== undefined) {
      forwarded[key] = value;
    }
  }

  return forwarded;
}

/**
 * In a real host this renders a dialog and waits for a click. Here the user's
 * answers are injected so the run stays reproducible: the first destructive
 * request is declined and the second is approved, which exercises both branches
 * of the consent gate.
 */
let consentAsked = 0;
const requestConsent: ConsentHandler = async ({ tool, args }) => {
  consentAsked += 1;
  const approved = consentAsked > 1;
  console.log(`   ? consent ${approved ? "APPROVED" : "DECLINED"} for ${tool}(${JSON.stringify(args)})`);
  return approved;
};

/**
 * Chapter 03 — the handoff. Everything *after* the model's choice is
 * deterministic, which is exactly why the host's policy lives here:
 *
 *     classify → consent → invoke → (retry, but only when a retry is safe) → audit
 *
 * Returning `undefined` means "the host refused"; a returned object always means
 * the server was actually called and here is what it said.
 */
async function callWithPolicy(
  client: Client,
  policy: HostPolicy,
  tool: DiscoveredTool,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | undefined> {
  const decision = policy.classify(tool);

  // Branch 3 — never shown. Defence in depth: even if a name leaked into the
  // prompt, the host refuses here rather than trusting the prompt to be clean.
  if (decision.tier === "denied") {
    audit.record({ actor: ACTOR, tool: tool.name, decision: "blocked", outcome: "denied", args, durationMs: 0 });
    console.log(`   x ${tool.name} refused by host policy (${decision.reason})`);
    return undefined;
  }

  // Branch 2 — ask the user. The model may *propose*; it may not authorise.
  if (decision.tier === "confirm") {
    const approved = await policy.requestConsent({ tool: tool.name, args });

    if (!approved) {
      audit.record({ actor: ACTOR, tool: tool.name, decision: "confirm", outcome: "denied", args, durationMs: 0 });
      console.log(`   x ${tool.name} denied — the server was never called`);
      return undefined;
    }
  }

  /**
   * Chapter 08 §"Retries". Retry only on a *transport* failure — a protocol
   * error, where the call demonstrably never happened — and only when the
   * operation cannot duplicate a side effect. `isError: true` is **not**
   * retryable: the call ran, and repeating it would duplicate the damage.
   */
  const safeToRetry = tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true;
  const startedAt = performance.now();
  let attempt = 0;

  for (;;) {
    attempt += 1;

    try {
      const result = await client.callTool({ name: tool.name, arguments: args });
      const isError = result.isError === true;

      audit.record({
        actor: ACTOR,
        tool: tool.name,
        decision: decision.tier,
        outcome: isError ? "error" : "ok",
        args,
        durationMs: performance.now() - startedAt,
      });

      return { text: text(result), isError };
    } catch (error) {
      if (attempt > 1 || !safeToRetry) {
        audit.record({
          actor: ACTOR,
          tool: tool.name,
          decision: decision.tier,
          outcome: "error",
          args,
          durationMs: performance.now() - startedAt,
        });
        throw error;
      }

      log.warn("host.retry", { tool: tool.name, attempt, reason: "transport error on a safe-to-retry tool" });
      console.log(`   ~ transport error on ${tool.name}; retrying once because it is safe to retry`);
    }
  }
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------ 1 · CONNECT
  const client = new Client({ name: "task-host", version: "1.0.0" });

  // The transport is chosen by the host; the server neither knows nor cares
  // which binding it is. Here the client spawns the server as a child process.
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverEntry],
      cwd: projectRoot,
      stderr: "inherit",
      // Chapter 08 — the server gets its own knobs and nothing else.
      env: serverEnvironment(),
    }),
  );

  console.log("1. connect     -> spawned the server over stdio");

  // ------------------------------------------------------------- 2 · HANDSHAKE
  // Chapter 04 — capabilities are permissions, not niceties. The host reads what
  // the server *declared* before it calls anything, and `instructions` is the
  // one channel a server has for describing itself.
  const capabilities = Object.keys(client.getServerCapabilities() ?? {});
  console.log(`2. handshake   -> capabilities: ${capabilities.sort().join(", ") || "(none)"}`);

  const instructions = client.getInstructions();
  if (instructions !== undefined) {
    console.log(`   instructions: "${clip(instructions)}"`);
  }

  // ------------------------------------------------------------- 3 · DISCOVERY
  // Chapter 07 §7.2 — `tools/list`. Discovery is a curated act: the server chose
  // what appears here, and an absent tool cannot be called by a model that was
  // never told it exists.
  const { tools } = await client.listTools();
  const catalogue = [...tools].sort((left, right) => left.name.localeCompare(right.name));

  console.log(`\n3. tools/list  -> ${catalogue.length} tools discovered`);
  for (const entry of catalogue) {
    const annotations = entry.annotations ?? {};
    console.log(
      `   ${entry.name.padEnd(14)} readOnly=${String(annotations.readOnlyHint === true).padEnd(5)}` +
        ` destructive=${String(annotations.destructiveHint === true).padEnd(5)}` +
        ` idempotent=${String(annotations.idempotentHint === true)}`,
    );
  }

  // ---------------------------------------------------------- 4 · HOST POLICY
  // Chapter 08 §8.1 — "discovering a tool does not mean the model should
  // automatically be allowed to execute everything."
  const policy = createHostPolicy({
    allowDestructive: env.MCP_HOST_ALLOW_DESTRUCTIVE,
    requireConsent: env.MCP_HOST_REQUIRE_CONSENT,
    requestConsent,
    logger: log,
  });

  const visible = policy.visible(tools);

  console.log(`\n4. host policy -> ${visible.length} of ${tools.length} tools shown to the model`);
  for (const row of policy.review(catalogue)) {
    console.log(`   ${row.tier.padEnd(8)} ${row.name.padEnd(14)} ${row.reason}`);
  }

  /** The host resolves a model-chosen *name* to a discovered definition. */
  const tool = (name: string): DiscoveredTool => {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) {
      throw new Error(`the server did not expose ${name}`);
    }
    return found;
  };

  // ------------------------------------------ 5 · SELECTION (the model's job)
  console.log("\n5. selection   -> (stand-in for the model) create_task");

  // ------------------------------------------------------ 6 · INVOCATION
  // Chapter 07 §7.4 — `tools/call`. The model named a tool, not a server: the
  // host resolves the name to this client, and this client to this server.
  const REQUEST_KEY = "demo-request-42";

  const created = await callWithPolicy(client, policy, tool("create_task"), {
    title: "Record MCP Video",
    idempotencyKey: REQUEST_KEY,
  });
  console.log(`   tools/call create_task            -> ${created?.text ?? "(not invoked)"}`);

  // The same key again: a retry must not create a second task.
  const replayed = await callWithPolicy(client, policy, tool("create_task"), {
    title: "Record MCP Video",
    idempotencyKey: REQUEST_KEY,
  });
  console.log(`   tools/call create_task (same key) -> ${replayed?.text ?? "(not invoked)"}`);

  await callWithPolicy(client, policy, tool("create_task"), { title: "Publish the notes" });

  // -------------------------------------------------- 7 · BUSINESS FAILURES
  // Chapter 05 §5.7 — a tool execution error is a *result*, not a broken
  // connection: the call ran, the operation failed, and the text is written so
  // the model can recover instead of inventing success.
  console.log("\n6. failures    -> tool execution errors (`isError: true`)");

  const missing = await callWithPolicy(client, policy, tool("complete_task"), { id: 999 });
  console.log(`   complete_task id=999 -> isError=${missing?.isError === true} ${missing?.text ?? ""}`);

  const completed = await callWithPolicy(client, policy, tool("complete_task"), { id: 1 });
  console.log(`   complete_task id=1   -> ${completed?.text ?? ""}`);

  const conflict = await callWithPolicy(client, policy, tool("complete_task"), { id: 1 });
  console.log(`   complete_task id=1   -> isError=${conflict?.isError === true} ${conflict?.text ?? ""}`);

  // ------------------------------------------------------- 8 · CONSENT GATE
  console.log("\n7. consent     -> delete_task is destructive (Chapter 08 §8.1)");

  const declined = await callWithPolicy(client, policy, tool("delete_task"), { id: 2 });
  console.log(`   delete_task id=2     -> ${declined === undefined ? "not invoked" : declined.text}`);

  const deleted = await callWithPolicy(client, policy, tool("delete_task"), { id: 2 });
  console.log(`   delete_task id=2     -> ${deleted?.text ?? "(not invoked)"}`);

  // ----------------------------------------------------------- 9 · RESOURCES
  // Chapter 06 §6.3 — the *application* drives these, and the model never asked.
  // Reading a resource executes nothing; that is the whole distinction from a tool.
  const { resources } = await client.listResources();
  console.log(`\n8. resources   -> resources/list: ${resources.map((entry) => entry.uri).join(", ")}`);

  const { resourceTemplates } = await client.listResourceTemplates();
  console.log(`   templates    -> ${resourceTemplates.map((entry) => entry.uriTemplate).join(", ")}`);

  const first = resources[0];
  if (first === undefined) {
    throw new Error("the server exposed no resources");
  }

  const policyRead = await client.readResource({ uri: first.uri });
  console.log(`   read ${first.uri} -> ${resourceText(policyRead.contents).length} chars`);

  const taskRead = await client.readResource({ uri: "company://tasks/1" });
  console.log(`   read company://tasks/1 -> ${clip(resourceText(taskRead.contents).replace(/\s+/g, " "), 110)}`);

  // A missing resource is a **protocol error**, not a result: nothing executed,
  // so there is no `isError` channel and no recovery instruction to write.
  try {
    await client.readResource({ uri: "company://tasks/999" });
    console.log("   read company://tasks/999 -> unexpectedly succeeded");
  } catch (error) {
    console.log(`   read company://tasks/999 -> protocol error: ${(error as Error).message}`);
  }

  // ------------------------------------------------------------- 10 · PROMPTS
  // Chapter 06 §6.7 — the *user* drives these. A prompt is a template, so it
  // asks the model to call a tool rather than baking in live data.
  const { prompts } = await client.listPrompts();
  console.log(`\n9. prompts     -> prompts/list: ${prompts.map((entry) => entry.name).join(", ")}`);

  const prompt = await client.getPrompt({ name: "daily_task_briefing", arguments: { owner: "Aminul" } });
  const message = prompt.messages[0];
  const promptBody = message === undefined ? "" : text({ content: [message.content] });
  console.log(`   prompts/get daily_task_briefing -> ${clip(promptBody.replace(/\n/g, " "), 130)}`);

  // --------------------------------------------------------------- 11 · AUDIT
  // Chapter 08 — "how do I prove it after the fact?" The arguments are hashed,
  // never stored: enough to correlate a retry, useless for reconstructing PII.
  console.log("\n10. audit      -> every decision, with hashed arguments");
  console.log(
    `   ${"time".padEnd(13)}${"tool".padEnd(15)}${"decision".padEnd(10)}${"outcome".padEnd(9)}${"argsHash".padEnd(18)}ms`,
  );

  for (const record of audit.entries()) {
    console.log(
      `   ${record.at.slice(11, 23).padEnd(13)}${record.tool.padEnd(15)}${record.decision.padEnd(10)}` +
        `${record.outcome.padEnd(9)}${record.argsHash.padEnd(18)}${record.durationMs}`,
    );
  }

  await client.close();
  console.log("\ndone.");
}

main().catch((error: unknown) => {
  // A demo CLI must fail *loudly and promptly*. `process.exitCode` alone would
  // leave the spawned server's pipe open, so the shell would sit there waiting
  // for a process that has nothing left to do.
  console.error(error);
  process.exit(1);
});
```

## 17.3 Block-by-block explanation

### Block 1 — the two roles, and the one probabilistic step

The header comment names both jobs this file does:

> This process is the **host**: it owns the conversation, the policy and the user experience, and it
> spawns exactly one MCP **client** for exactly one server (the 1:1 rule). The server is the
> capability provider from `src/index.ts`, and it knows nothing about this file.

Chapter 04's 1:1 rule is why there is exactly one `new Client(...)` in the project. A host with three
servers would have three clients — and would still never let one client hold two servers, because that
would destroy the isolation the protocol exists to provide.

Then the lifecycle:

> Chapter 07 — the lifecycle runs top to bottom: handshake → discovery → selection → consent →
> invocation → result. Note which step is probabilistic (only the selection) and which are ordinary,
> testable software (everything else).

That distinction is the chapter's spine, and the demo makes it visible by numbering the steps. Read the
output as a table of who decided what:

| Step | Protocol call | Who decides | Deterministic? |
| :--- | :--- | :--- | :--- |
| 1 · connect | — | the host | yes |
| 2 · handshake | `initialize` | the host + server | yes |
| 3 · discovery | `tools/list` | the server (it chose the catalogue) | yes |
| 4 · policy | — | the host | yes |
| 5 · **selection** | — | **the model** | **no** |
| 6 · invocation | `tools/call` | the host | yes |
| 7 · failures | `tools/call` | the server | yes |
| 8 · consent | — | the user | **no** (a human answered) |
| 9 · resources | `resources/list`, `resources/read` | the application | yes |
| 10 · prompts | `prompts/list`, `prompts/get` | the user | **no** (a human picked) |

Three non-deterministic steps, and the file is honest about all three: step 5 is stood in for by a
constant, step 8 by a scripted handler, and step 10 by a hardcoded prompt name. **Everything else in
this file is ordinary software** — which is Chapter 07's point: *"two of the five phases are
non-deterministic, and they are the first and the last."*

### Block 2 — the module-level singletons, and the one that is not

```ts
const log = createLogger(env.MCP_LOG_LEVEL, { host: "task-host" });
const audit = createAuditLog(log);

const ACTOR = "user:demo";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
```

**What it does:** creates the host's logger and audit trail once, and resolves two paths.
**How it works:** module-scope `const`s, which is the right choice for a single-run CLI.

**`createLogger(env.MCP_LOG_LEVEL, { host: "task-host" })`** — the binding is `host`, not `server`.
That single word is what makes the two processes' log lines distinguishable in a combined stream, and
it is why the demo's log shows `"host":"task-host"` on the audit lines and `"server":"task-mcp-server"`
on the tool lines. **Same logger code, different binding, unambiguous attribution.**

**`createAuditLog(log)` is passed the logger, not given a new one.** So an audit record appears in the
same stream as everything else, with the same binding and the same redaction policy (Chapter 03). A
separate logger would mean a separate level threshold and a separate binding — two ways for the trail
and the log to disagree.

**`const ACTOR = "user:demo"`** — the identity, with the comment that matters:

> It comes from the session — **never from the model**, because a model-authored identity is a
> privilege escalation waiting to happen (Chapter 03).

This is worth stating as a rule, because the temptation is real. A host that lets the model supply an
`actor` argument to a tool has handed the model the ability to *say who it is* — and every downstream
authorisation check becomes meaningless. The identity comes from the transport (a session, a token, a
logged-in user), and the model never sees it as a parameter. Chapter 03's mistake table says it
directly: *"Passing a user identity as a tool argument — the model can then change who it is acting
as."*

In this demo `ACTOR` is a constant because there is no real session. That is a limitation, not a
design — and it is the right kind of limitation: the value is *hardcoded by the host*, which preserves
the property that the model cannot influence it.

**`fileURLToPath(new URL("../..", import.meta.url))`** — the project root, derived from this file's own
location. `import.meta.url` is the file's URL; `new URL("../..", …)` walks up two levels (from
`src/host/` to the project root); `fileURLToPath` converts back to a filesystem path.

Two things this buys:

1. **No `process.cwd()` dependency.** The paths are absolute and derived from the file, so
   `npm run host` works from the project directory, from a parent, or via an absolute invocation —
   whereas a `cwd`-relative path would break the moment the script ran from elsewhere.
2. **`cwd: projectRoot` matters for the child process.** The server is spawned with this as its working
   directory, which is what lets its `dotenv` find `.env`. Without it, the server would look for `.env`
   in *this* process's cwd — the same today, and silently different the moment the host is invoked
   from another directory.

**`serverEntry`** is `src/index.ts`, the server's entry point — passed to `tsx` as the script to run.
Note it points at the `.ts` source, not a build output: `args: ["--import", "tsx", serverEntry]` makes
the child Node process load `tsx` as a loader and then execute the TypeScript directly.

### Block 3 — the two extractors, and why there are two

```ts
/** Chapter 05 §5.6 — a result is `content[]` blocks, never a bare value. */
function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

function resourceText(contents: ReadonlyArray<{ text?: string; blob?: string }>): string {
  return contents
    .map((content) => content.text ?? (content.blob === undefined ? "" : "[binary content]"))
    .join(" ")
    .trim();
}
```

**What they do:** pull readable text out of the two different wire shapes.
**How they work:** `text` filters by a `type` discriminator; `resourceText` checks for `text` versus
`blob`.

**They exist separately because the wire contracts are genuinely different**, and the comment says so:

> Resource contents are `{ uri, mimeType, text | blob }` — a *different* shape from a tool's content
> blocks, which carry a `type` discriminator. Two extractors, because they are two different wire
> contracts.

Side by side:

| | Tool result | Resource contents |
| :--- | :--- | :--- |
| Shape | `content: [{ type: "text", text }]` | `contents: [{ uri, mimeType, text }]` |
| How you know it is text | `block.type === "text"` | the presence of `text` (vs `blob`) |
| Other variants | image, audio, resource link, embedded resource | base64 `blob` |
| Also carries | — | `uri` |

Writing one function to handle both would need a union and a branch, and would hide the fact that the
two were designed separately. **Two functions, each five lines, is clearer than one function that lies
about having a single input type.**

**`text` is deliberately loose about its input: `result: { content?: unknown }`.** It does not import
the SDK's `CallToolResult` type, so it works on anything with an optional `content` — including the
prompt result, which the demo also passes through it (`text({ content: [message.content] })` in
Block 7). The `?? []` handles a missing `content`, and the `as Array<...>` narrows `unknown` at the one
place where the shape is known.

**The `.filter(block => block.type === "text")`** discards non-text blocks rather than crashing on
them. A tool that returned an image would produce an empty string here rather than a `TypeError` — the
right failure for a *display* helper.

**`resourceText` handles the binary case explicitly**: `content.text ?? (content.blob === undefined ? "" : "[binary content]")`.
A `blob` becomes the literal `"[binary content]"` rather than an empty string, so a binary resource is
*visible* in the demo output instead of silently blank. The comment states the second reason for naming
both variants in the parameter type:

> Both variants are named in the parameter type so the compiler can check that a binary resource is
> handled rather than silently dropped.

That is a subtle TypeScript point worth spelling out. A parameter typed
`ReadonlyArray<{ text?: string }>` would **reject** the blob variant, because a type whose properties are
all optional is a "weak type" and requires at least one property in common. Naming `blob?: string` as
well gives the two variants a shared vocabulary, so the function accepts both and the `??` chain
handles each. Without it, the compiler refused the call — which is how this was found.

**`clip(value, max = 100)`** is the third helper, purely cosmetic: the demo prints long strings
(instructions, prompts), and truncating them keeps the output readable. The `…` suffix marks the
truncation, so a reader knows the string continues.

### Block 4 — `serverEnvironment`: least privilege for the process environment

```ts
function serverEnvironment(): Record<string, string> {
  const forwarded: Record<string, string> = { ...getDefaultEnvironment() };

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("MCP_") && value !== undefined) {
      forwarded[key] = value;
    }
  }

  return forwarded;
}
```

**What it does:** builds the environment the server child process receives.
**How it works:** start from the SDK's safe default, then add only the `MCP_*` variables.

**This function exists because of a genuinely surprising SDK behaviour**, documented in the comment:

> The stdio transport does **not** inherit this process's environment. With no `env` option it passes
> `getDefaultEnvironment()`: a small whitelist (PATH, HOME, SHELL, …) that a child process genuinely
> needs.

The SDK's own type declaration says it plainly: *"The environment to use when spawning the process. If
not specified, the result of `getDefaultEnvironment` will be used."* So `MCP_LOG_LEVEL=warn npm run host`
sets the variable for the *host* and not for the *server* — which is how it was discovered: the
server's `info` lines kept appearing.

**The default is the right one, and the comment explains why forwarding everything would be wrong:**

> A host's environment holds its model credentials, and a capability provider has no business reading
> them — so the server's configuration is forwarded **explicitly**, one variable at a time, and nothing
> else crosses the process boundary.

This is least privilege applied to a process boundary. A real host's environment contains
`OPENAI_API_KEY`, a database URL, session secrets. The server needs none of them — it needs
`MCP_TOOL_TIMEOUT_MS` and friends. Passing `process.env` wholesale would hand a capability provider the
host's credentials, which is exactly the confused-deputy problem Chapter 08 describes, one layer down.

**`key.startsWith("MCP_")` is the filter, and it is a naming convention doing security work.** Every
variable the server is allowed to see is prefixed `MCP_`. That makes the boundary *auditable*: you can
list what crosses it by listing the `MCP_`-prefixed names in `.env.example`, and a new secret added to
the host's environment is not forwarded by accident.

**`{ ...getDefaultEnvironment() }` is spread into a fresh object** rather than mutated. If
`getDefaultEnvironment()` returned a shared cached object, writing `MCP_*` keys into it would leak them
into every other caller. The spread is cheap insurance against a mutable default.

**`value !== undefined` guards the type, not the behaviour.** `process.env` is typed
`Record<string, string | undefined>` — a variable can be *present with an undefined value*. The check
narrows it to `string`, which is what `Record<string, string>` requires.

**The consequence, stated plainly:** `MCP_LOG_LEVEL=warn npm run host` now quiets **both** processes,
and `MCP_RATE_LIMIT_PER_MINUTE=1 npm run host` limits the **server**. Without this function, both
overrides would have affected only the host — and the second would have looked like a broken rate
limiter rather than a missing environment variable. That is exactly the bug this function prevents.

### Block 5 — the scripted consent handler

```ts
let consentAsked = 0;
const requestConsent: ConsentHandler = async ({ tool, args }) => {
  consentAsked += 1;
  const approved = consentAsked > 1;
  console.log(`   ? consent ${approved ? "APPROVED" : "DECLINED"} for ${tool}(${JSON.stringify(args)})`);
  return approved;
};
```

**What it does:** answers the consent question deterministically — no on the first ask, yes on the
second.
**How it works:** a closure over a counter, typed as the `ConsentHandler` the policy expects.

**The comment states the contract with reality:**

> In a real host this renders a dialog and waits for a click. Here the user's answers are injected so
> the run stays reproducible: the first destructive request is declined and the second is approved,
> which exercises both branches of the consent gate.

That is the *reason* for the counter: the demo needs to show **both** branches — a refusal and an
approval — and a handler that always answered the same way would show only one. Two calls to
`delete_task`, two different answers, both paths demonstrated.

**`const requestConsent: ConsentHandler = ...`** — the explicit type annotation is what makes the
injected function conform to the interface from Chapter 15. Without it, TypeScript would infer a
narrower function type, and a future change to `ConsentHandler` (say, an added field on
`ConsentRequest`) would fail at the *call site* instead of here. Annotating at the definition puts the
error where the fix is.

**The handler prints to stdout, not through the logger.** Deliberate: this line is part of the *demo
narrative* — the reader is watching a user be asked — whereas the policy's own `policy.consent` line
(Chapter 15) goes to stderr as structured data. **Same event, two audiences, two channels.** The human
sees `? consent DECLINED for delete_task({"id":2})`; the operator sees
`{"event":"policy.consent","tool":"delete_task","approved":false}`.

**`JSON.stringify(args)` in the message is safe here, and would not be in production.** The arguments
are `{"id":2}` — an integer. A real consent dialog would render the arguments as a form and would not
log them; the demo prints them because the reader needs to see *what* was being consented to. This is
the one place in the codebase where raw arguments are written to a stream, and it is worth naming that
it is a demo affordance rather than a pattern to copy.

**`consentAsked > 1` rather than `=== 2`** — the handler approves on every ask after the first. With
the default configuration only two asks occur (the demo calls `delete_task` twice), so the two forms
are equivalent; `>` is simply more robust to a third call, which would also be approved. In a real host
the answer would come from the user each time, and no counter would exist.

### Block 6 — `callWithPolicy`: the handoff

```ts
async function callWithPolicy(
  client: Client,
  policy: HostPolicy,
  tool: DiscoveredTool,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | undefined> {
```

**What it does:** takes a model's *proposal* — a tool and some arguments — and turns it into either a
refusal or a result.
**How it works:** three explicit parameters rather than reaching for a closure, and a return type that
distinguishes the two outcomes.

**The comment names this as Chapter 03's handoff:**

> Chapter 03 — the handoff. Everything *after* the model's choice is deterministic, which is exactly
> why the host's policy lives here:
>
> ```text
> classify → consent → invoke → (retry, but only when a retry is safe) → audit
> ```

That pipeline is the function's structure, and it is why the policy sits here rather than in the
server. Everything before this function is probabilistic (the model chose); everything inside it is
deterministic software. **This is the boundary Chapter 03 draws between tool calling and MCP** — and
here it is a function signature.

**`Promise<{ text: string; isError: boolean } | undefined>` — the union is the API.** The comment
states the contract precisely:

> Returning `undefined` means "the host refused"; a returned object always means the server was
> actually called and here is what it said.

That is a genuinely useful distinction for a caller. `undefined` means *no call happened* — either
policy denied it or the user declined — and the caller's message must not claim otherwise. The
alternative (returning a result with a synthetic `isError: true`) would blur the two cases: the model
would see "the tool failed" when in fact the tool was never invoked. **A refusal and a failure are
different facts, and the return type keeps them apart.**

**`client: Client` and `policy: HostPolicy` are parameters, not module-level references.** `client` is
created inside `main`, so it must be passed; `policy` is created in `main` too. Passing both makes the
function's dependencies explicit and would let a test call it with a fake client and a fake policy.
The one thing it does *not* take is the logger or the audit log — those are module-level, because they
are genuinely process-wide.

**`tool: DiscoveredTool`, not `tool: string`.** The function needs the *annotations* (for the retry
decision), so it takes the whole definition rather than a name and a lookup. That is why `main` has a
`tool(name)` resolver (Block 9): the model names a tool, and the host resolves the name to the
definition it discovered.

**`args: Record<string, unknown>`** — the raw arguments from the model, passed straight through to
`client.callTool` and to `audit.record`. The host does not interpret them: their shape is the server's
contract, and the host's job is to carry them, hash them and forward them.

### Block 7 — the three refusal/consent branches

```ts
const decision = policy.classify(tool);

// Branch 3 — never shown. Defence in depth: even if a name leaked into the
// prompt, the host refuses here rather than trusting the prompt to be clean.
if (decision.tier === "denied") {
  audit.record({ actor: ACTOR, tool: tool.name, decision: "blocked", outcome: "denied", args, durationMs: 0 });
  console.log(`   x ${tool.name} refused by host policy (${decision.reason})`);
  return undefined;
}

// Branch 2 — ask the user. The model may *propose*; it may not authorise.
if (decision.tier === "confirm") {
  const approved = await policy.requestConsent({ tool: tool.name, args });

  if (!approved) {
    audit.record({ actor: ACTOR, tool: tool.name, decision: "confirm", outcome: "denied", args, durationMs: 0 });
    console.log(`   x ${tool.name} denied — the server was never called`);
    return undefined;
  }
}
```

**What it does:** applies the policy verdict before any call reaches the server.
**How it works:** two early returns, each preceded by an audit record.

**`policy.classify(tool)` is called here even though `visible()` already filtered the catalogue.** That
redundancy is the point, and the comment names it:

> Branch 3 — never shown. Defence in depth: even if a name leaked into the prompt, the host refuses
> here rather than trusting the prompt to be clean.

Two independent checks of the same condition. If the catalogue filter worked, this branch never fires —
and if a tool name reached the model by some other route (a prompt injection, a stale cache, a bug in
the filter), this branch still refuses. **The second check costs one function call and closes the class
of failure where the first check was bypassed.**

That is why Chapter 16's `AuditRecord` distinguishes `"blocked"` from `"denied"`: this branch records
`decision: "blocked"`, so a `"blocked"` row in the trail means the defence-in-depth check fired — an
anomaly worth investigating, because it should be unreachable.

**`durationMs: 0` on both refusal records, and that is honest rather than lazy.** No work was done, no
call was made, so there is no duration to report. A fabricated `performance.now()` delta would measure
the *audit call itself*, which is meaningless. Zero says "this did not take time because nothing
happened."

**The two console messages are different, deliberately:**

| Branch | Message | What it tells the reader |
| :--- | :--- | :--- |
| `denied` | `refused by host policy (reason)` | policy said no, and here is why |
| `confirm` → declined | `denied — the server was never called` | a human said no |

The second message exists to pre-empt a misreading: seeing a refusal after a consent prompt, a reader
might assume the tool ran and failed. **"the server was never called"** removes that doubt in four
words. The same clarity is in Chapter 16's `outcome: "denied"`, distinct from `"error"`.

**The `!approved` check is on the boolean, not on a status code.** The injected handler returns
`Promise<boolean>` (Chapter 15), so there is nothing else to check — and a `false` is unambiguous
because the handler has no way to express "I do not know". **A tri-state return would have been a
mistake here:** an "unknown" answer to a consent question must not default to either branch, and the
only safe design is a boolean the host must resolve before proceeding.

**Both branches `return undefined`, not a thrown error.** A refusal is a *normal* outcome — the system
working as designed — so it does not propagate as an exception. It flows back to `main`, which prints
`not invoked`. Only a genuine transport failure throws (Block 8).

### Block 8 — the retry loop, and the annotation that governs it

```ts
const safeToRetry = tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true;
const startedAt = performance.now();
let attempt = 0;

for (;;) {
  attempt += 1;

  try {
    const result = await client.callTool({ name: tool.name, arguments: args });
    const isError = result.isError === true;

    audit.record({
      actor: ACTOR,
      tool: tool.name,
      decision: decision.tier,
      outcome: isError ? "error" : "ok",
      args,
      durationMs: performance.now() - startedAt,
    });

    return { text: text(result), isError };
  } catch (error) {
    if (attempt > 1 || !safeToRetry) {
      audit.record({ actor: ACTOR, tool: tool.name, decision: decision.tier, outcome: "error", args, durationMs: … });
      throw error;
    }

    log.warn("host.retry", { tool: tool.name, attempt, reason: "transport error on a safe-to-retry tool" });
    console.log(`   ~ transport error on ${tool.name}; retrying once because it is safe to retry`);
  }
}
```

**What it does:** invokes the tool, retrying exactly once and only when a retry cannot duplicate a side
effect.
**How it works:** an unbounded `for (;;)` with explicit exits, and a `catch` that decides whether to loop
or rethrow.

**The retry policy is derived from the tool's own annotations**, and the comment states the rule:

> Chapter 08 §"Retries". Retry only on a *transport* failure — a protocol error, where the call
> demonstrably never happened — and only when the operation cannot duplicate a side effect.
> `isError: true` is **not** retryable: the call ran, and repeating it would duplicate the damage.

Two conditions, both required. Walk the four tools through it:

| Tool | `readOnlyHint` | `idempotentHint` | `safeToRetry` | Why |
| :--- | :---: | :---: | :---: | :--- |
| `list_tasks` | ✓ | ✓ | **true** | reads nothing, changes nothing |
| `complete_task` | ✗ | ✓ | **true** | completing twice leaves it completed |
| `create_task` | ✗ | ✗ | **false** | a retry could create a second task |
| `delete_task` | ✗ | ✗ | **false** | a retry could not be satisfied — the task is gone |

Note `complete_task`: it is *not* read-only, but it *is* idempotent, and the retry is safe because the
worst case is a `CONFLICT` (Chapter 08) — a result, not a duplicate. That is exactly what
`idempotentHint` means, and it is why the check is `readOnly || idempotent` rather than just `readOnly`.

**The `catch` is the *only* place a retry can happen, and that is the design.** `isError: true` never
reaches the `catch` — it is a *returned* value, so the `try` block handles it and returns. Only a
*thrown* error (a JSON-RPC error, a transport failure) enters the `catch`. **The two error mechanisms
from Chapter 05 map exactly onto the two paths here**, which is why the retry logic can be a single `if`
instead of a taxonomy of failure kinds.

**`attempt > 1 || !safeToRetry`** — the exit condition, read as "give up if we have already retried, or
if a retry is not safe". The `attempt > 1` half bounds the loop at two iterations. It is checked first
because it is the cheaper condition and because it is the one that guarantees termination.

**`for (;;)` rather than `while (true)`** — the same thing; the form with no condition makes the absence
of a loop condition explicit, which is appropriate when every exit is a `return` or a `throw` inside the
body. It is also the form that constant-condition linters accept.

**`startedAt` is outside the loop**, so `durationMs` measures the *total* time including the retry —
which is what a user experienced. Timing each attempt separately would understate the latency of the
call that was actually retried.

**The audit record is written on both paths**, with the same shape. The `catch` block repeats the whole
`audit.record({...})` call rather than sharing a helper, because the fields differ only in `outcome` —
and a shared helper taking an `outcome` parameter would be a third indirection for a two-case branch.
Four repeated lines are more legible than one abstraction here.

**`log.warn("host.retry", …)` uses `warn`, not `info`.** A retry means something went wrong at the
transport layer. Not fatal, not an error — but worth an operator's attention, which is what `warn`
means. Same reasoning as `policy.tool_hidden` in Chapter 15.

**The retry is not exercised by the demo.** Nothing in a healthy run throws — the only failures are
`isError: true` results, which do not retry. So this branch is wired but unexercised, and that is stated
in the README's "Honest limits" rather than implied. The code is here because a host *must* have a retry
policy; it is unreached because the demo has nothing to fail at.

### Block 9 — `main`, steps 1–4: connect, handshake, discovery, policy

```ts
const client = new Client({ name: "task-host", version: "1.0.0" });

await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", serverEntry],
    cwd: projectRoot,
    stderr: "inherit",
    env: serverEnvironment(),
  }),
);
```

**`new Client({ name, version })`** — the client's own identity, sent in `initialize`. Note it is the
*host's* name, not the server's: the protocol negotiates two identities, and a server may use the
client's to decide what to expose.

**`command: process.execPath`** — the path to the Node binary currently running this script, rather than
the string `"node"`. The child therefore runs the *same* Node version as the parent, so a
version-specific behaviour cannot differ between them. It also works when Node is not on the `PATH` (a
bundled runtime, an unusual install).

**`args: ["--import", "tsx", serverEntry]`** — `--import tsx` registers the TypeScript loader before the
entry point loads, so the child can execute `.ts` directly. The `--import` form is the modern replacement
for `--loader`, and it is why no build step is needed.

**`stderr: "inherit"`** — the child's stderr is connected to this process's stderr. That single option is
what makes the demo's log stream a *merged* view of both processes, which is why the audit lines
(`"host":"task-host"`) and the tool lines (`"server":"task-mcp-server"`) appear interleaved in the same
output. **Without it, the server's diagnostics would be swallowed.**

Then the handshake:

```ts
const capabilities = Object.keys(client.getServerCapabilities() ?? {});
console.log(`2. handshake   -> capabilities: ${capabilities.sort().join(", ") || "(none)"}`);

const instructions = client.getInstructions();
if (instructions !== undefined) {
  console.log(`   instructions: "${clip(instructions)}"`);
}
```

**`Object.keys(client.getServerCapabilities() ?? {})`** — the `?? {}` is required: the getter returns
`ServerCapabilities | undefined`, and `Object.keys(undefined)` throws. The empty-object fallback means a
server that declared nothing prints `(none)` rather than crashing.

**`.sort()` on the keys** — the SDK builds the capabilities object in an order derived from the
registrations, and the demo output should be stable across runs. Cosmetic, but it makes the output
diffable.

**`getInstructions()` returns `string | undefined`, and the check is `!== undefined`.** A server that
declared no instructions prints nothing rather than an empty line — the difference between "there are no
instructions" and "the instructions are empty", which the protocol treats as distinct.

Then discovery and policy:

```ts
const { tools } = await client.listTools();
const catalogue = [...tools].sort((left, right) => left.name.localeCompare(right.name));
```

**`const catalogue = [...tools].sort(...)` — a sorted copy, not a sort in place.** `tools` comes from the
SDK, and `.sort()` mutates its receiver. Spreading first leaves the SDK's array untouched, and
`catalogue` is the sorted view used for display. Same discipline as `taskStore.list()` returning a copy.

**The `policy` is created after discovery, not before.** It takes `env.MCP_HOST_ALLOW_DESTRUCTIVE` and
`env.MCP_HOST_REQUIRE_CONSENT` — configuration, available from the start — so the ordering is not a
dependency. It is placed here because a reader encounters the policy *after* seeing the catalogue it
judges, which is the order this guide explains it in.

**`policy.visible(tools)` and `policy.review(catalogue)` are both called**, and the demo prints the count
from the first and the table from the second. Deliberate: the count is the *enforcement*
(`3 of 4 tools shown`), and the table is the *explanation* (why each tool got its tier). A reader sees
the effect and the reasoning side by side.

**The `tool(name)` resolver throws on a missing name:**

```ts
const tool = (name: string): DiscoveredTool => {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`the server did not expose ${name}`);
  }
  return found;
};
```

That `throw` is a **demo guard, not a policy decision**. In a real host the model's chosen name would come
from the catalogue the host showed it, so a miss would mean a bug — and a hard failure is the right
response. Note it throws a plain `Error`, not a `ToolError`: this is not a tool failure the model should
recover from, it is the *host* discovering its own inconsistency. The `throw` propagates to
`main().catch` and exits with code 1.

### Block 10 — `main`, steps 5–8: selection, invocation, failures, consent

```ts
console.log("\n5. selection   -> (stand-in for the model) create_task");
```

**That single line is the honest stand-in for the one probabilistic step.** A real host would send the
user's message plus the tool catalogue to a model, receive a tool-call proposal, and continue from there.
The demo hardcodes the choice — and *labels it as hardcoded*, which is why the output says
`(stand-in for the model)`. **A demo that pretended to be a model would be lying; a demo that names its
substitution is teaching.**

The invocation then uses the same key twice:

```ts
const REQUEST_KEY = "demo-request-42";

const created = await callWithPolicy(client, policy, tool("create_task"), {
  title: "Record MCP Video",
  idempotencyKey: REQUEST_KEY,
});
console.log(`   tools/call create_task            -> ${created?.text ?? "(not invoked)"}`);

const replayed = await callWithPolicy(client, policy, tool("create_task"), {
  title: "Record MCP Video",
  idempotencyKey: REQUEST_KEY,
});
console.log(`   tools/call create_task (same key) -> ${replayed?.text ?? "(not invoked)"}`);
```

**`REQUEST_KEY` is a `const`, and it is used twice — that is the whole demonstration.** The second call is
a byte-identical request, and Chapter 07's store recognises the key and replays instead of writing. This
is what makes the audit table's two matching `argsHash` values possible (Chapter 16).

**`created?.text ?? "(not invoked)"`** — the optional chain plus fallback handles the `undefined` that
means "the host refused". In this configuration `create_task` is `auto`-tier, so it never refuses — but
the code handles it, because the *same helper* is used for `delete_task` (step 8), where a refusal is the
point. **One helper, three possible outcomes, all displayed.**

The failures section then exercises all three of `complete_task`'s outcomes:

```ts
const missing = await callWithPolicy(client, policy, tool("complete_task"), { id: 999 });
console.log(`   complete_task id=999 -> isError=${missing?.isError === true} ${missing?.text ?? ""}`);

const completed = await callWithPolicy(client, policy, tool("complete_task"), { id: 1 });
console.log(`   complete_task id=1   -> ${completed?.text ?? ""}`);

const conflict = await callWithPolicy(client, policy, tool("complete_task"), { id: 1 });
console.log(`   complete_task id=1   -> isError=${conflict?.isError === true} ${conflict?.text ?? ""}`);
```

**`missing?.isError === true` is printed, not assumed.** The demo *shows* the flag rather than describing
it, which is what makes the `isError` mechanism observable. Note the `=== true` comparison — consistent
with the rest of the codebase, and it means a missing result prints `isError=false` rather than
`isError=undefined`.

**`id: 999` first, then `id: 1` twice** — the three outcomes in the order Chapter 08 explains them:
`NOT_FOUND`, success, `CONFLICT`. The second and third calls are identical, which is what makes the third
one's `CONFLICT` a genuine state check rather than a special case.

And the consent gate:

```ts
const declined = await callWithPolicy(client, policy, tool("delete_task"), { id: 2 });
console.log(`   delete_task id=2     -> ${declined === undefined ? "not invoked" : declined.text}`);

const deleted = await callWithPolicy(client, policy, tool("delete_task"), { id: 2 });
console.log(`   delete_task id=2     -> ${deleted?.text ?? "(not invoked)"}`);
```

**The first line's ternary is written differently from the others, and deliberately.** For the refusal,
the interesting fact is that *nothing happened* — so the message leads with `"not invoked"`. For the
second call, the interesting fact is the result, so it uses the same `?? "(not invoked)"` pattern as the
rest. **The message follows the point being made.**

**Two calls, two different answers** — the scripted consent handler (Block 5) doing its job. Both branches
of the consent gate are demonstrated in two lines of code.

### Block 11 — `main`, steps 9–10: resources and prompts

```ts
const { resources } = await client.listResources();
console.log(`\n8. resources   -> resources/list: ${resources.map((entry) => entry.uri).join(", ")}`);

const { resourceTemplates } = await client.listResourceTemplates();
console.log(`   templates    -> ${resourceTemplates.map((entry) => entry.uriTemplate).join(", ")}`);

const first = resources[0];
if (first === undefined) {
  throw new Error("the server exposed no resources");
}
```

**Two discovery calls, because resources have two catalogues.** `resources/list` returns concrete
addresses; `resources/templates/list` returns URI patterns. Chapter 11 showed these are genuinely
different sets — an empty family lists as empty while its pattern remains addressable — so a host that
wants the full picture must call both. **The demo does, and prints both**, which is what makes the
distinction visible in the output.

**`const first = resources[0]; if (first === undefined) throw ...`** — the `noUncheckedIndexedAccess`
guard, and it is not decorative. The array *can* be empty (Chapter 11's empty-board probe returned only
the two policies, and a server exposing no resources at all is legal). Without the guard, `first.uri`
would be a runtime `TypeError`; with it, the failure is a named message.

Then the two reads, one of which is expected to fail:

```ts
const policyRead = await client.readResource({ uri: first.uri });
console.log(`   read ${first.uri} -> ${resourceText(policyRead.contents).length} chars`);

const taskRead = await client.readResource({ uri: "company://tasks/1" });
console.log(`   read company://tasks/1 -> ${clip(resourceText(taskRead.contents).replace(/\s+/g, " "), 110)}`);

try {
  await client.readResource({ uri: "company://tasks/999" });
  console.log("   read company://tasks/999 -> unexpectedly succeeded");
} catch (error) {
  console.log(`   read company://tasks/999 -> protocol error: ${(error as Error).message}`);
}
```

**The static read prints a character count; the templated read prints a snippet.** Two renderings for two
resources, chosen by what is interesting: a policy's *length* is the fact worth knowing (it is a
document), and a task's *content* is what matters (it is data). **The display follows the content, not a
uniform rule.**

**`.replace(/\s+/g, " ")` collapses the pretty-printed JSON onto one line.** Chapter 11's templated
resource uses `JSON.stringify(task, null, 2)` — readable for a human, but a multi-line string would break
the demo's one-line-per-step format. Collapsing whitespace is the display's job, not the resource's.

**The `try`/`catch` around the third read demonstrates the *other* error mechanism.** Chapter 11 explained
that a missing resource is a protocol error, not an `isError` result — and this is where a host *sees*
that: the call **throws**, so a `try` is required. Compare the tool failures in Block 10, which returned
values and needed no `try` at all. **Two mechanisms, two host-side shapes.**

**The `console.log("… unexpectedly succeeded")` inside the `try` is a guard, not a message.** If the read
somehow succeeded, the output would say so, and a reader would immediately know the server had changed
behaviour. A silent `try` with only a `catch` would hide that.

Then prompts:

```ts
const { prompts } = await client.listPrompts();
console.log(`\n9. prompts     -> prompts/list: ${prompts.map((entry) => entry.name).join(", ")}`);

const prompt = await client.getPrompt({ name: "daily_task_briefing", arguments: { owner: "Aminul" } });
const message = prompt.messages[0];
const promptBody = message === undefined ? "" : text({ content: [message.content] });
console.log(`   prompts/get daily_task_briefing -> ${clip(promptBody.replace(/\n/g, " "), 130)}`);
```

**`text({ content: [message.content] })` — the *tool* extractor, reused for a prompt.** That works because
both wire shapes use the same `{ type: "text", text }` content block, and it is why `text` was typed
loosely (`{ content?: unknown }`) in Block 3. **One helper for the two shapes that are the same; a second
helper for the one that differs.**

**`message === undefined ? "" : …`** — the `noUncheckedIndexedAccess` guard again. A prompt that returned
no messages is legal, and the guard turns it into an empty string rather than a crash.

**`.replace(/\n/g, " ")`** — the prompt is a multi-line instruction (Chapter 12), and the demo prints one
line per step. Same reasoning as the JSON collapse above: the formatting belongs to the display.

**`arguments: { owner: "Aminul" }`** — supplied by the *host*, on behalf of the user. That is the control
model: the user picks the prompt, the user supplies the arguments, and the model is not involved until the
resulting message enters the context.

### Block 12 — `main`, step 11: the audit table, and the exit

```ts
console.log("\n10. audit      -> every decision, with hashed arguments");
console.log(
  `   ${"time".padEnd(13)}${"tool".padEnd(15)}${"decision".padEnd(10)}${"outcome".padEnd(9)}${"argsHash".padEnd(18)}ms`,
);

for (const record of audit.entries()) {
  console.log(
    `   ${record.at.slice(11, 23).padEnd(13)}${record.tool.padEnd(15)}${record.decision.padEnd(10)}` +
      `${record.outcome.padEnd(9)}${record.argsHash.padEnd(18)}${record.durationMs}`,
  );
}

await client.close();
console.log("\ndone.");
```

**`record.at.slice(11, 23)`** — an ISO 8601 timestamp is `2026-10-23T11:02:50.737Z`, and characters 11 to
23 are `11:02:50.737`. The date is identical for every row in a single run, so showing it on each line
would be noise. **A slice is the right tool rather than a date library**, because the input format is
known and fixed — it was generated by `new Date().toISOString()` in Chapter 16.

**`.padEnd(n)` on every column** — a fixed-width table, so the columns line up. The widths come from the
longest expected value: `create_task` and `complete_task` are 13 characters, hence 15; `decision` holds
`confirm` (7) and `blocked` (7), hence 10. **A table that lines up is readable; one that does not is a
wall of text.**

**`audit.entries()` returns the copy** (Chapter 16), so the loop cannot corrupt the trail — and the
records were accumulated as the run progressed, which is why they appear in chronological order.

**`await client.close()` is called before the final message.** That closes the transport, which closes the
child's stdin, which is the shutdown path from Chapter 14 that needs no signal handler. **The `done.` line
prints only after the server has been told to stop**, so a clean exit is observable in the output.

Then the top-level error handler:

```ts
main().catch((error: unknown) => {
  // A demo CLI must fail *loudly and promptly*. `process.exitCode` alone would
  // leave the spawned server's pipe open, so the shell would sit there waiting
  // for a process that has nothing left to do.
  console.error(error);
  process.exit(1);
});
```

**`process.exit(1)`, not `process.exitCode = 1`.** This was a real bug found while building the demo:
setting `exitCode` marks the eventual exit status but does not *exit*, and the spawned server's pipe was
still open — so the shell waited for a process that had nothing left to do. The run hung until a timeout
killed it. **`process.exit(1)` closes the process immediately, the child's stdin reaches EOF, and the
server exits on its own.**

The comment records exactly that, which is the right way to handle a bug fix: the *reason* is written
down, so a future reader does not "simplify" it back to `exitCode`.

**`console.error(error)` writes to stderr**, keeping the demo narrative (stdout) and the failure (stderr)
on separate channels, consistent with every other line in the project.

**`error: unknown`** — the promise rejection's type under `strict`. Passing it straight to `console.error`
is safe: Node renders an `Error` with its stack and anything else with `util.inspect`. This is one of the
two places a *raw* error reaches a stream (the other is the transport's `onerror` in Chapter 14) —
acceptable because both are process-level failures with no model waiting on a recovery sentence.

### Block 13 — the lifecycle, mapped to the chapters

Stepping back from the code, the demo's output is a walk through the whole lecture. Map each numbered
section to the chapter that explains it:

| Demo output | Protocol traffic | Explained in |
| :--- | :--- | :--- |
| `1. connect` | `initialize` (spawn + handshake) | Chapters 04, 14 |
| `2. handshake` | `initialize` result | Chapters 02, 13 |
| `3. tools/list` | `tools/list` | Chapters 05, 10 |
| `4. host policy` | — (host-side) | Chapters 08, 15 |
| `5. selection` | — (model, stood in for) | Chapter 03 |
| `6. failures` | `tools/call` ×3 | Chapters 05, 08 |
| `7. consent` | `tools/call` ×2 | Chapters 08, 15 |
| `8. resources` | `resources/list`, `resources/templates/list`, `resources/read` ×3 | Chapters 06, 11 |
| `9. prompts` | `prompts/list`, `prompts/get` | Chapters 06, 12 |
| `10. audit` | — (host-side) | Chapters 08, 16 |

Read the middle column: **seven protocol methods across five categories**, and the host drives every one
of them. The model appears once, in the row with no protocol traffic at all — which is Chapter 04's
"there is no arrow from the LLM to any server" made visible in a demo's output.

---

## 17.4 Run / verify

The whole run, from the top:

```bash
npm run host
```

```text
1. connect     -> spawned the server over stdio
2. handshake   -> capabilities: completions, logging, prompts, resources, tools
   instructions: "Task server. Every mutation is keyed by the numeric task id, so call list_tasks first to read exact …"

3. tools/list  -> 4 tools discovered
   complete_task  readOnly=false destructive=false idempotent=true
   create_task    readOnly=false destructive=false idempotent=false
   delete_task    readOnly=false destructive=true  idempotent=false
   list_tasks     readOnly=true  destructive=false idempotent=true

4. host policy -> 4 of 4 tools shown to the model
   auto     complete_task  no destructive hint
   auto     create_task    no destructive hint
   confirm  delete_task    destructiveHint is set: irreversible, so it needs explicit consent
   auto     list_tasks     readOnlyHint is set

5. selection   -> (stand-in for the model) create_task
   tools/call create_task            -> Task #1 created: Record MCP Video (PENDING).
   tools/call create_task (same key) -> Task #1 already existed (idempotent replay): Record MCP Video (PENDING).

6. failures    -> tool execution errors (`isError: true`)
   complete_task id=999 -> isError=true No task with id 999. Call list_tasks to read the exact ids, then retry.
   complete_task id=1   -> Task completed: #1 Record MCP Video (COMPLETED).
   complete_task id=1   -> isError=true Task #1 is already COMPLETED. Nothing to do — report the current state instead of retrying.

7. consent     -> delete_task is destructive (Chapter 08 §8.1)
   ? consent DECLINED for delete_task({"id":2})
   x delete_task denied — the server was never called
   delete_task id=2     -> not invoked
   ? consent APPROVED for delete_task({"id":2})
   delete_task id=2     -> Task deleted: #2 Publish the notes.

8. resources   -> resources/list: company://policies/return-policy, company://policies/refund-policy, company://tasks/1
   templates    -> company://tasks/{taskId}
   read company://policies/return-policy -> 97 chars
   read company://tasks/1 -> { "id": 1, "title": "Record MCP Video", "status": "COMPLETED", "createdAt": "2026-10-23T11:02:50.731Z", "updat…
   read company://tasks/999 -> protocol error: Resource not found: company://tasks/999

9. prompts     -> prompts/list: daily_task_briefing, review_pull_request
   prompts/get daily_task_briefing -> You are preparing a task briefing for Aminul. Call list_tasks to read the current board, then answer with at most three bullets: 1…

10. audit      -> every decision, with hashed arguments
   time         tool           decision  outcome  argsHash          ms
   11:02:50.737 create_task    auto      ok       57036086e66b5396  33
   11:02:50.741 create_task    auto      ok       57036086e66b5396  2
   11:02:50.743 create_task    auto      ok       fe096691f37c3caa  2
   11:02:50.746 complete_task  auto      error    aa0c17ac393b495d  3
   11:02:50.749 complete_task  auto      ok       037c9214eef74cc3  3
   11:02:50.752 complete_task  auto      error    037c9214eef74cc3  2
   11:02:50.752 delete_task    confirm   denied   9e7e65453739bbc6  0
   11:02:50.758 delete_task    confirm   ok       9e7e65453739bbc6  5

done.
```

The run exits with code **0**. Six things are worth pulling out of it, and each was explained in its own
chapter:

1. **`completions` appears in the capabilities** although nothing declared it — the SDK inferred it from
   the resource template's `complete` callback (Chapter 13).
2. **The catalogue carries the annotations verbatim** (Chapter 10), and the policy table reacts to exactly
   the `destructiveHint` column (Chapter 15).
3. **The replay produced the same task id** and a different message — the idempotency key at work
   (Chapter 07).
4. **Three `complete_task` outcomes, three different sentences** (Chapter 08), including the `CONFLICT`
   that tells the model *not* to retry.
5. **The consent gate refused once and approved once** (Chapter 15), and the audit records `denied` then
   `ok` with the **same `argsHash`** (Chapter 16).
6. **The resource miss is a protocol error** (`read company://tasks/999 -> protocol error: …`), not an
   `isError` result — the only failure in the run that would have required a `try` (Chapter 11).

Now the other policy branch, end to end:

```bash
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run host | sed -n '11,12p;26,30p'
```

```text
4. host policy -> 3 of 4 tools shown to the model
   denied   delete_task    destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false

7. consent     -> delete_task is destructive (Chapter 08 §8.1)
   x delete_task refused by host policy (destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false)
   delete_task id=2     -> not invoked
   x delete_task refused by host policy (destructiveHint is set and MCP_HOST_ALLOW_DESTRUCTIVE is false)
   delete_task id=2     -> (not invoked)
```

**`3 of 4` and two refusals** — and note the message is `refused by host policy`, not `denied — the server
was never called`. The two refusal messages from Block 7 are distinguishable in the output, which is how a
reader can tell *which* branch fired.

And the environment forwarding from Block 4, which makes the server's configuration controllable from the
host's command line:

```bash
MCP_LOG_LEVEL=warn npm run host 1>/dev/null 2>/tmp/warn.txt
cat /tmp/warn.txt
```

```text
{"ts":"…","level":"warn","event":"tool.failure","server":"task-mcp-server","tool":"complete_task","code":"NOT_FOUND","retryable":false,"message":"No task with id 999."}
{"ts":"…","level":"warn","event":"tool.failure","server":"task-mcp-server","tool":"complete_task","code":"CONFLICT","retryable":false,"message":"Task #1 is already COMPLETED."}
```

Two lines instead of roughly twenty — the level filter applied to **both** processes. Note the binding:
`"server":"task-mcp-server"`, so these are the *server's* warnings, quieted correctly by a variable set on
the *host's* command line. Without `serverEnvironment()` (Block 4), these lines would have appeared
regardless, and the override would have looked broken.

Finally, confirm the exit code and that nothing is left running:

```bash
npm run host > /dev/null 2>&1; echo "exit code: $?"
```

```text
exit code: 0
```

Zero, and no orphaned child process — the `await client.close()` from Block 12 propagated to the server's
stdin, and the server exited on its own through the EOF path (Chapter 14).

---

## 17.5 Checkpoint

1. **The host owns the conversation, the policy and the user experience**, and it spawns exactly one
   client for exactly one server — the 1:1 rule.
2. **Only the selection is probabilistic.** Everything from `callWithPolicy` onward is ordinary, testable
   software; the demo names its stand-in for the model rather than pretending.
3. **`undefined` from `callWithPolicy` means no call happened.** A refusal and a failure are different
   facts, and the return type keeps them apart.
4. **The policy is checked twice** — once as a catalogue filter, once before invocation. The second check
   closes the class of failure where the first was bypassed, and its audit value is `"blocked"`.
5. **Retry is governed by the tool's own annotations**: only on a *thrown* transport error, and only when
   `readOnlyHint` or `idempotentHint` says a duplicate is impossible. `isError: true` never retries.
6. **The stdio transport does not inherit the environment.** The host forwards `MCP_*` explicitly, which
   is least privilege applied to a process boundary — the server never sees the host's credentials.
7. **`stderr: "inherit"` merges both processes' logs**, which is why the audit lines and the tool lines
   appear in one stream with different bindings.
8. **Two error mechanisms, two host-side shapes.** Tool failures return values; resource misses throw, and
   only the second needs a `try`.
9. **`process.exit(1)`, not `exitCode = 1`.** Setting the code without exiting leaves the child's pipe open
   and the shell hangs — a real bug, recorded in the comment.

---

## 17.6 Where to go next

This is the last chapter of the guide, so the honest closing note is about what this codebase does *not*
do — the things a real deployment would add on top of the shape established here.

**A real model in place of the stand-in.** The one substitution is step 5. Everything downstream of it —
discovery, policy, consent, invocation, audit — is already the real thing, which is why the substitution is
one `console.log` and one hardcoded name rather than a rewrite.

**Persistence.** `TaskStore` and the audit trail are in-process (Chapters 07 and 16). Both sit behind
interfaces, so replacing them means writing a second implementation of a handful of methods.

**A second server.** The 1:1 rule says the host would own a second client. Nothing in this codebase would
need to change except `main` — and the tool-namespacing problem (two servers offering `list_tasks`) is the
interesting new work.

**Remote transport.** `src/index.ts` is the only transport-aware file (Chapter 14). Streamable HTTP means
replacing that file and adding the OAuth layer Chapter 08 describes — and the host's policy and audit trail
become *more* important, not less, because a remote server is one you trust less.

**Resource subscriptions and dynamic discovery.** Chapter 11 recorded what the high-level SDK does not
provide. Both are achievable with the low-level `Server`, at the cost of the clarity this codebase is built
on.

The through-line: **every one of those extensions lands in a layer that already exists**, because the
boundaries were drawn before the features were added. That is the thing worth taking from the guide.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 16 — Host: The Audit Trail](./16_Host_Audit.md)
















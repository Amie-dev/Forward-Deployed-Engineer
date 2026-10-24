# Chapter 26 — The Lifecycle Walkthrough

> **`npm run lifecycle` — the same pipeline the HTTP host runs, driven step by step with the intermediate state printed.**
> The HTTP API shows you an answer; this shows you *who decided what, in what order, and why*.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/host/lifecycle.ts` (456 lines) |
| **Layer** | `host` — a demo CLI, and the project's executable argument |
| **Purpose** | Build the host's graph, drive all 13 steps of the lecture, and print the state at each one. |
| **Exports** | *(none — it is a program)* |
| **Lecture sections** | All of them. Ch02 §2.4, Ch03 §3.1/3.9, Ch04, Ch05, Ch06, Ch07 §7.3, Ch08 §8.1/8.2/8.6 |
| **Runs** | `npm run lifecycle` |

---

## Commands

```bash
npm run lifecycle                      # all 13 steps
npm run lifecycle 2>/dev/null          # the printed walkthrough only
MCP_LOG_LEVEL=info npm run lifecycle 2>&1 >/dev/null | head -20   # the log stream it produces

# the two configuration variants it demonstrates
MCP_HOST_ALLOW_DESTRUCTIVE=false npm run lifecycle 2>/dev/null | sed -n '/^2\./,/^3\./p'
MCP_MAX_CONTEXT_CHARS=300 npm run lifecycle 2>/dev/null | sed -n '/^9\./,/^10\./p'
```

---

## The thirteen steps

| # | Step | Demonstrates |
| :---: | :--- | :--- |
| 1 | `handshake` | Capabilities are **negotiated**, not guessed |
| 2 | `tools/list` | The policy review — four tools, four decisions |
| 3 | `intent` | **The same payload, two owners** — the lecture's core |
| 4 | `resources/list` | **Discovery is not consumption** |
| 5 | `resources/read` | Static, templated and JSON through one verb |
| 6 | `failures` | A missing Resource is a **protocol error**, not `isError` |
| 7 | `the ACL` | The same URI, judged by three sessions |
| 8 | `selection` | Five queries, five strategies, every choice reasoned |
| 9 | `the budget` | Three caps biting at once, **and the marker that says so** |
| 10 | `prompts` | A template, not an answer — and no model call |
| 11 | `GET /plan` | **One request, three primitives, three owners** |
| 12 | `audit` | Who asked for what, and how it ended |
| 13 | `metrics` | The numbers a dashboard would scrape |

Thirteen steps, and the order is the lecture's order: the protocol (1–7), then the host's own reasoning (8–10), then the
composition (11), then the after-the-fact record (12–13).

---

## What this file is for

The header states the purpose and then names the three things it stands in for:

> This is the same pipeline the HTTP host runs, driven step by step with the intermediate state printed — which is the only
> way to see the **control model** rather than its result.
>
> It also stands in for the parts a browser host would provide:
>
> · **it starts the server**, because a host owns the lifecycle of the processes it spawns;
> · **it answers the consent prompt**, deterministically, so the run is reproducible;
> · **it prints the audit table and the metrics**, which is what an operator would look at after the fact.

Those three are exactly the parts of a real host that a demo would otherwise have to fake — and each is implemented rather
than stubbed:

| A browser host would… | This file… |
| :--- | :--- |
| Spawn or connect to the server | `ensureServer()` — probes, then spawns detached |
| Show a consent dialog | `requestConsent` — scripted and deterministic |
| Have an operator dashboard | Steps 12–13 — the audit table and the metrics |

**`npm run lifecycle` is therefore not a test.** It is a *reference host*, with a CLI instead of a UI — and that is why it is
the thing the README tells a new reader to run first. It is the only artifact in the project that shows the whole system's
behaviour in one screen.

---

## `src/host/lifecycle.ts` — the full file

```ts
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { env, hasModelKey } from "../config/env.js";
import { createContextBudget } from "../core/guards.js";
import { createLogger } from "../core/logger.js";
import { createMetrics } from "../core/metrics.js";
import { createResourceCatalogue } from "../domain/resourceCatalogue.js";
import { createAuditLog } from "../host/audit.js";
import { textOf } from "../host/client.js";
import { assembleContext } from "../host/context.js";
import type { HostDeps } from "../host/deps.js";
import { askModel } from "../host/model.js";
import { createHostPolicy, type ConsentHandler, type Session } from "../host/policy.js";
import { createSelectionService } from "../services/selectionService.js";
import { createMcpClient, type McpClient } from "./client.js";

/**
 * The walkthrough: `npm run lifecycle`.
 *
 * This is the same pipeline the HTTP host runs, driven step by step with the
 * intermediate state printed — which is the only way to see the *control model*
 * rather than its result. The HTTP API shows you an answer; this shows you who
 * decided what, in what order, and why.
 *
 * It also stands in for the parts a browser host would provide:
 *
 *  · **it starts the server**, because a host owns the lifecycle of the processes
 *    it spawns;
 *  · **it answers the consent prompt**, deterministically, so the run is
 *    reproducible;
 *  · **it prints the audit table and the metrics**, which is what an operator
 *    would look at after the fact.
 */

const log = createLogger(env.MCP_LOG_LEVEL, { host: "lifecycle" });
const metrics = createMetrics();

const session: Session = { actor: "123", projects: ["fde"], isAdmin: false };

/** The identity every audit record is attributed to — from the session, never the model. */
const indent = (text: string, prefix = "   "): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

const clip = (value: string, max = 120): string =>
  value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max})`;

/**
 * The scripted consent gate.
 *
 * Notes Ch08 §8.1 — *"discovering a tool does not mean the model should
 * automatically be allowed to execute everything."* This answers the way a user
 * would: **no** for an irreversible deletion, and it says why. Both branches are
 * exercised below so the printed run shows the gate working in each direction.
 */
let consentCount = 0;

const requestConsent: ConsentHandler = async ({ tool, args }) => {
  consentCount += 1;
  const approved = consentCount > 1;

  console.log(
    `   ? consent ${approved ? "APPROVED" : "DECLINED"} for ${tool}(${JSON.stringify(args)})` +
      (approved ? "" : "  — the user did not authorise this"),
  );

  return approved;
};

/** Start the server if it is not already listening, and keep the handle to stop it. */
async function ensureServer(client: () => Promise<McpClient>): Promise<{ spawned: boolean; stop: () => void }> {
  try {
    const probe = await client();
    await probe.close();
    return { spawned: false, stop: () => undefined };
  } catch {
    // Not reachable, so this process becomes the host that owns it.
  }

  // `detached: true` puts the server in its own process group, so the whole
  // `npx → tsx → node` chain can be stopped with one negative-pid signal.
  const child = spawn("npx", ["tsx", "src/index.ts"], { stdio: "inherit", detached: true });

  return {
    spawned: true,
    stop: () => {
      if (child.pid === undefined) {
        return;
      }

      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
}

async function connectWithRetry(): Promise<McpClient> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      return await createMcpClient({ url: env.MCP_SERVER_URL, logger: log, metrics });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Could not reach the MCP server at ${env.MCP_SERVER_URL}: ${String(lastError)}`);
}

async function main(): Promise<void> {
  const { spawned, stop } = await ensureServer(() =>
    createMcpClient({ url: env.MCP_SERVER_URL, logger: log, metrics }),
  );

  if (spawned) {
    console.log(`   (started the MCP server at ${env.MCP_SERVER_URL})`);
  }

  const client = await connectWithRetry();

  // The host's own graph — the same objects `routes/index.ts` builds.
  const catalogue = createResourceCatalogue();

  const policy = createHostPolicy({
    allowDestructive: env.MCP_HOST_ALLOW_DESTRUCTIVE,
    requireConsent: env.MCP_HOST_REQUIRE_CONSENT,
    allowedSchemes: new Set(env.MCP_ALLOWED_RESOURCE_SCHEMES),
    catalogue,
    allowedPrompts: env.MCP_HOST_ALLOWED_PROMPTS,
    requestConsent,
    logger: log,
  });

  const budget = createContextBudget({
    maxResources: env.MCP_MAX_RESOURCES_PER_REQUEST,
    maxResourceChars: env.MCP_MAX_RESOURCE_CHARS,
    maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
  });

  const selection = createSelectionService({ catalogue });
  const audit = createAuditLog(log);

  const deps: HostDeps = {
    client,
    policy,
    selection,
    budget,
    audit,
    logger: log,
    metrics,
    limits: {
      maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
      maxResourceChars: env.MCP_MAX_RESOURCE_CHARS,
      maxContextChars: env.MCP_MAX_CONTEXT_CHARS,
    },
  };

  try {
    /* ── 1 · HANDSHAKE ─────────────────────────────────────────────────────── */

    const capabilities = client.raw.getServerCapabilities() ?? {};
    const version = client.raw.getServerVersion();

    console.log("\n1. handshake   -> capabilities are negotiated, not guessed");
    console.log(`   server       ${version?.name ?? "?"} v${version?.name === undefined ? "?" : (version.version ?? "?")}`);
    console.log(`   capabilities ${Object.keys(capabilities).sort().join(", ")}`);
    console.log(`   instructions ${clip(client.raw.getInstructions() ?? "(none)", 140)}`);
    console.log(
      `   model        ${hasModelKey ? env.OPENAI_MODEL : "offline — the pipeline runs without one, and that is a feature"}`,
    );

    /* ── 2 · TOOLS, AND THE POLICY THAT GOVERNS THEM ───────────────────────── */

    const tools = await client.listTools();
    const review = policy.review(tools);
    const visible = policy.visible(tools);

    console.log(`\n2. tools/list  -> ${tools.length} discovered, ${visible.length} shown to the model`);
    for (const row of review) {
      console.log(`   ${row.tier.padEnd(8)} ${row.name.padEnd(15)} ${row.reason}`);
    }

    /* ── 3 · THE SAME PAYLOAD, TWO OWNERS (Notes Ch02 §2.4) ────────────────── */

    const toolCall = await client.callTool("list_tasks", {});
    const toolText = textOf(toolCall);
    const backlog = await client.read("task://backlog");

    console.log("\n3. intent      -> list_tasks (Tool) and task://backlog (Resource), side by side");
    console.log(`   tools/call list_tasks      -> ${clip(toolText.replace(/\n/g, " "), 100)}`);
    console.log(`   resources/read task://backlog -> ${clip(backlog.text.replace(/\n/g, " "), 100)}`);
    console.log(
      `   identical payloads: ${toolText === backlog.text ? "YES — the same bytes" : "NO — the renderers have drifted"}.` +
        " The difference is who decided to fetch them, not what came back.",
    );

    /* ── 4 · DISCOVERY IS NOT CONSUMPTION (Notes Ch03 §3.1) ────────────────── */

    const { resources, templates } = await client.listResources();

    console.log("\n4. resources/list -> metadata only: the client knows what exists, not what it says");
    for (const resource of resources) {
      console.log(`   ${resource.uri.padEnd(30)} ${clip(resource.description ?? "", 70)}`);
    }
    for (const template of templates) {
      console.log(`   ${template.uriTemplate.padEnd(30)} (template) ${clip(template.description ?? "", 60)}`);
    }

    /* ── 5 · THE THREE SHAPES (Notes Ch04 §4.4–4.7) ────────────────────────── */

    const guidelines = await client.read("task://guidelines");
    const project = await client.read("task://projects/fde");
    const taskDoc = await client.read("task://tasks/1");

    console.log("\n5. resources/read -> static, templated and JSON, all through one verb");
    console.log(`   task://guidelines        STATIC    ${guidelines.chars} chars, ${guidelines.mimeType}`);
    console.log(`   task://projects/fde      TEMPLATE  ${project.chars} chars`);
    console.log(indent(clip(project.text.replace(/\n/g, " | "), 110)));
    console.log(`   task://tasks/1           TEMPLATE  ${taskDoc.chars} chars, ${taskDoc.mimeType}`);
    console.log(indent(clip(taskDoc.text.replace(/\s+/g, " "), 110)));

    /* ── 6 · A MISSING RESOURCE IS A PROTOCOL ERROR (Notes Ch03 §3.9) ──────── */

    console.log("\n6. failures    -> a missing Resource is a protocol error, not an isError result");

    for (const uri of ["task://tasks/999", "task://nope", "file:///etc/passwd"]) {
      try {
        await client.read(uri);
        console.log(`   ${uri.padEnd(24)} -> unexpectedly succeeded`);
      } catch (error) {
        console.log(`   ${uri.padEnd(24)} -> ${clip((error as Error).message, 90)}`);
      }
    }

    /* ── 7 · THE ACL (Notes Ch04 §"Authorisation") ─────────────────────────── */

    console.log("\n7. the ACL     -> the same URI, judged by three different sessions");
    for (const actor of [
      { ...session },
      { actor: "456", projects: ["media"], isAdmin: false },
      { ...session, isAdmin: true },
    ]) {
      const decision = policy.mayRead("user://456/profile", actor);

      console.log(
        `   actor ${actor.actor.padEnd(5)} admin=${String(actor.isAdmin).padEnd(5)} -> ` +
          `${decision.allowed ? "ALLOWED" : "REFUSED"}  ${decision.reason}`,
      );
    }

    /* ── 8 · SELECTION (Notes Ch05) ────────────────────────────────────────── */

    console.log("\n8. selection   -> the application chooses, and every choice carries its reason");

    const queries = [
      "what is on my plate",
      "how busy am I?",
      "plan my day",
      "show me task 2",
      "what should I do in project media",
    ];

    for (const query of queries) {
      const result = await selection.select({
        message: query,
        scope: { userId: session.actor, projects: session.projects, isAdmin: session.isAdmin },
        limit: env.MCP_MAX_RESOURCES_PER_REQUEST,
      });

      const picks = result.chosen.map((chosen) => `${chosen.uri} ← ${chosen.strategy}`).join("; ") || "(none)";

      console.log(`   "${query}"`);
      console.log(`      strategies=[${result.strategies.join(", ")}] candidates=${result.candidates}`);
      console.log(`      chosen: ${picks}`);
    }

    // Strategy 1 — an explicit choice. It outranks every inference, which is why
    // it scores 1 and why the chapter calls it the highest-quality strategy.
    const attached = await selection.select({
      message: "show me task 2",
      attached: ["task://summary"],
      scope: { userId: session.actor, projects: session.projects, isAdmin: session.isAdmin },
      limit: env.MCP_MAX_RESOURCES_PER_REQUEST,
    });

    console.log('   "show me task 2" + the user attached task://summary');
    console.log(
      `      strategies=[${attached.strategies.join(", ")}] top=${attached.chosen[0]?.uri} ` +
        `(score ${attached.chosen[0]?.score}) — an explicit choice beats every guess`,
    );

    /* ── 9 · THE BUDGET (Notes Ch02 §"Size and token budget") ──────────────── */

    console.log("\n9. the budget  -> cap the count, cap each body, cap the total — and say so");

    // A deliberately tiny budget, so the three caps all bite at once.
    const tight = createContextBudget({ maxResources: 2, maxResourceChars: 120, maxContextChars: 200 });
    const fit = tight.fit([
      { uri: "task://guidelines", strategy: "state", text: guidelines.text },
      { uri: "task://backlog", strategy: "retrieval", text: backlog.text },
      { uri: "task://summary", strategy: "retrieval", text: "x".repeat(500) },
    ]);

    console.log(`   limits ${JSON.stringify(tight.limits)}`);
    console.log(`   kept ${fit.blocks.length} block(s), ${fit.usedChars} chars, dropped [${fit.dropped.join(", ")}]`);

    for (const block of fit.blocks) {
      console.log(
        `      ${block.uri.padEnd(20)} truncated=${String(block.truncated).padEnd(5)} ${block.originalChars} -> ${block.text.length} chars`,
      );
    }

    // The marker is the point: the model is *told* it received a fragment.
    console.log(indent(clip(fit.blocks[0]?.text.slice(-100) ?? "", 100)));

    /* ── 10 · PROMPTS: A TEMPLATE, NOT AN ANSWER (Notes Ch06 §6.8) ────────── */

    const promptList = await client.listPrompts();

    console.log(`\n10. prompts/list -> ${promptList.length} workflows, each advertising its own arguments`);
    for (const prompt of promptList) {
      const args = (prompt.arguments ?? []).map((arg) => `${arg.name}${arg.required === true ? "" : "?"}`).join(", ");
      console.log(`   ${prompt.name}(${args})`);
      console.log(`      ${clip(prompt.description ?? "", 100)}`);
    }

    const rendered = await client.getPrompt("plan_day", { availableHours: "4" });
    const promptMessages = rendered.messages.map((message) => ({
      role: message.role as "user" | "assistant",
      text: textOf({ content: [message.content] }),
    }));

    console.log("    prompts/get plan_day { availableHours: 4 } -> the messages, and nothing else");
    console.log(indent(clip(promptMessages.map((message) => message.text).join(" "), 200)));
    console.log("    no model was called. That is Notes Ch07 §7.3, and it is why this step is testable.");

    audit.record({
      actor: session.actor,
      action: "prompt",
      target: "plan_day",
      decision: "allowed",
      outcome: "ok",
      args: { availableHours: "4" },
      durationMs: 0,
      note: `${promptMessages.length} message(s), no model call`,
    });

    /* ── 11 · THE END-TO-END REQUEST (Notes Ch08 §8.2) ────────────────────── */

    const context = await assembleContext(
      { message: "Plan my day with 4 hours available.", session, promptMessages },
      {
        client,
        policy,
        selection,
        budget,
        logger: log,
        metrics,
        maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
      },
    );

    const reply = await askModel({
      system: context.system,
      messages: context.messages,
      logger: log,
      metrics,
    });

    console.log("\n11. GET /plan?hours=4 -> one request, three primitives, three owners");
    console.log("   USER      -> prompts/get plan_day { availableHours: 4 }");
    console.log(
      `   APP       -> selected [${context.selection.strategies.join(", ")}] ` +
        `${context.included.join(", ")} (${context.chars} chars of ${env.MCP_MAX_CONTEXT_CHARS})`,
    );
    console.log(
      `   MODEL     -> ${reply.source === "model" ? reply.model : "offline: no key, so the assembled request is echoed"}`,
    );
    console.log(indent(clip(reply.text.replace(/\n+/g, " "), 230)));

    for (const chosen of context.selection.chosen) {
      audit.record({
        actor: session.actor,
        action: "resource",
        target: chosen.uri,
        decision: "allowed",
        outcome: "ok",
        args: { uri: chosen.uri },
        durationMs: 0,
        note: `${chosen.strategy}: ${chosen.reason}`,
      });
    }

    /* ── 12 · AUDIT (Notes Ch08 §8.6) ─────────────────────────────────────── */

    const toolTier = review.find((row) => row.name === "list_tasks")?.tier ?? "auto";

    audit.record({
      actor: session.actor,
      action: "tool",
      target: "list_tasks",
      decision: toolTier,
      outcome: "ok",
      args: {},
      durationMs: 0,
      note: "read-only, auto-approved",
    });

    console.log("\n12. audit      -> who asked for what, what the host decided, and how it ended");
    console.log(
      `   ${"time".padEnd(13)}${"action".padEnd(10)}${"target".padEnd(24)}${"decision".padEnd(10)}${"outcome".padEnd(9)}${"argsHash".padEnd(18)}ms`,
    );

    for (const record of audit.entries()) {
      console.log(
        `   ${record.at.slice(11, 23).padEnd(13)}${record.action.padEnd(10)}${record.target.padEnd(24)}` +
          `${record.decision.padEnd(10)}${record.outcome.padEnd(9)}${record.argsHash.padEnd(18)}${record.durationMs}`,
      );
    }

    console.log("   (arguments are hashed, never stored; resource content is never recorded at all)");

    /* ── 13 · METRICS ─────────────────────────────────────────────────────── */

    console.log("\n13. metrics    -> the numbers a dashboard would scrape");

    for (const [name, value] of Object.entries(metrics.snapshot())) {
      console.log(`   ${name.padEnd(40)} ${value}`);
    }
  } finally {
    await client.close();
    stop();
  }

  console.log("\ndone.");
}

// Run the walkthrough only when this file is executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // A demo CLI must fail *loudly and promptly*: `process.exitCode` alone would
    // leave the spawned server's pipe open, so the shell would sit there waiting
    // for a process that has nothing left to do.
    console.error(error);
    process.exit(1);
  });
}
```

### Block-by-block

**Block 1 — module-level state, and the identity (lines 1–38).**

```ts
const log = createLogger(env.MCP_LOG_LEVEL, { host: "lifecycle" });
const metrics = createMetrics();

const session: Session = { actor: "123", projects: ["fde"], isAdmin: false };
```

**Three module-level constants, and the third is the interesting one.** `session` is hard-coded — actor `123`, scoped to
project `fde`, not an admin — and the comment above it states the rule:

> The identity every audit record is attributed to — **from the session, never the model.**

That is Chapter 07's principle applied to the whole walkthrough. `123` is the same default the HTTP middleware uses
(Chapter 24), so the two paths produce comparable audit records, and `projects: ["fde"]` is why step 11's selection includes
`task://projects/fde ← state` — the scope that a bare `curl` does not have (Chapter 25).

`log` is bound with `{ host: "lifecycle" }`, the third distinct binding after `task-mcp-server` and `task-host`. So all
three processes' log lines are attributable, and the walkthrough's model observations (Chapter 22) land in the same stream as
the client's protocol traffic.

**Block 2 — the two formatting helpers (lines 40–45).**

```ts
const indent = (text: string, prefix = "   "): string =>
  text.split("\n").map((line) => `${prefix}${line}`).join("\n");

const clip = (value: string, max = 120): string =>
  value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max})`;
```

**`indent`** prefixes every line of a multi-line block, so an embedded document aligns with the step's other output. Small,
and it is what keeps a 13-step transcript readable when one step prints a resource body.

**`clip`** truncates with a **count of what was removed** — `…(+1020)` — rather than a bare ellipsis. That is the same
principle as the truncation marker in Chapter 06 and the empty-selection sentence in Chapter 21: **a stated omission is
information.** A reader of `…(+1020)` knows exactly how much they are not seeing, which is what makes a clipped transcript
trustworthy.

`max = 120` as a default parameter, so the common case needs no argument and the rare long case passes one.

**Block 3 — the scripted consent gate (lines 47–68).**

```ts
/**
 * The scripted consent gate.
 *
 * Notes Ch08 §8.1 — *"discovering a tool does not mean the model should
 * automatically be allowed to execute everything."* This answers the way a user
 * would: **no** for an irreversible deletion, and it says why. Both branches are
 * exercised below so the printed run shows the gate working in each direction.
 */
let consentCount = 0;

const requestConsent: ConsentHandler = async ({ tool, args }) => {
  consentCount += 1;
  const approved = consentCount > 1;

  console.log(
    `   ? consent ${approved ? "APPROVED" : "DECLINED"} for ${tool}(${JSON.stringify(args)})` +
      (approved ? "" : "  — the user did not authorise this"),
  );

  return approved;
};
```

**This is the file's most interesting function and its most important caveat, so both deserve stating plainly.**

**What it does:** it counts invocations and declines the first while approving the rest — *"Both branches are exercised
below so the printed run shows the gate working in each direction."* So the intent is a run that shows a refusal *and* an
approval, which is the right way to demo a consent gate: a gate that only ever approves is not visibly a gate.

**What actually happens: it is never invoked.** The comment says "both branches are exercised below", but no step calls a
`confirm`-tier tool — `delete_task` is classified `confirm` in step 2's table but no step calls it. So `consentCount` stays
`0`, `requestConsent` is never reached, and **no `policy.consent` line appears in any run.**

That gap is verifiable:

```bash
npm run lifecycle 2>&1 >/dev/null | grep -c '"event":"policy.consent"'
#    0
```

It is documented here rather than papered over because it is exactly the kind of thing that looks complete in a code
review — a scripted handler with a comment claiming both branches are exercised — and is empty in a run. The *seam* is
correct and the handler is correct; the **demonstration** is missing. Fixing it would mean adding a step that calls
`delete_task`, which would change the task store's state during a read-only walkthrough — a trade worth naming rather than
taking silently.

**The design of the handler is still worth reading**, because it is the shape a real host would use:

- It is `async`, because a real consent dialog is asynchronous (it waits for a click).
- It receives `{ tool, args }` — the tool name and its arguments — which is exactly what a dialog needs to display.
- It returns a boolean, so the policy can treat `false` as a refusal rather than an error.
- It prints with a `?` prefix, visually distinguishing a question to the user from the walkthrough's assertions.

And `ConsentHandler` is imported as a *type*, so the handler is checked against the policy's contract (Chapter 20) rather
than merely assumed to match.

**Block 4 — `ensureServer`, the host owning the server's lifecycle (lines 70–100).**

```ts
async function ensureServer(client: () => Promise<McpClient>): Promise<{ spawned: boolean; stop: () => void }> {
  try {
    const probe = await client();
    await probe.close();
    return { spawned: false, stop: () => undefined };
  } catch {
    // Not reachable, so this process becomes the host that owns it.
  }

  const child = spawn("npx", ["tsx", "src/index.ts"], { stdio: "inherit", detached: true });

  return {
    spawned: true,
    stop: () => {
      if (child.pid === undefined) {
        return;
      }

      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
}
```

**Probe, then spawn — and the probe is a real connection, not a port check.**

The `try` block opens a client and immediately closes it. If that succeeds, a server is already listening (perhaps one the
developer started), and the walkthrough returns `spawned: false` with a no-op `stop`. If it *throws*, no server is reachable,
and this process becomes the host that owns it.

**That is the right way to detect a service.** A `net.connect` port check would tell you a socket is open; an MCP handshake
tells you a *server that speaks the protocol* is there. Same instinct as Chapter 25's `/health`.

**`spawn("npx", ["tsx", "src/index.ts"], …)`** — the walkthrough runs the server the same way a developer would, so the
TSX-based development setup works without a build step. And `stdio: "inherit"` means the child's output lands in the same
terminal, which is why the server's boot line appears in the walkthrough's transcript.

**`detached: true` and the negative pid** are the interesting detail, and the comment explains it:

> `detached: true` puts the server in its own process group, so the whole `npx → tsx → node` chain can be stopped with one
> negative-pid signal.

That solves a real problem. `npx tsx src/index.ts` is **three processes** — npx, tsx, and the node process running the
TypeScript — and killing the npx wrapper leaves the node process orphaned and still holding port 8081. A process group lets
one `process.kill(-pid, …)` signal all three.

The `try/catch` around it is the fallback: if the process group has already gone (or the platform does not support negative
pids), it kills the child directly. So the cleanup degrades to a best-effort single kill rather than throwing during
teardown — which would be the worst time for an exception.

**Block 5 — `connectWithRetry`, and a bounded wait (lines 102–117).**

```ts
async function connectWithRetry(): Promise<McpClient> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      return await createMcpClient({ url: env.MCP_SERVER_URL, logger: log, metrics });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Could not reach the MCP server at ${env.MCP_SERVER_URL}: ${String(lastError)}`);
}
```

**A freshly spawned server takes time to listen**, so the first connection attempt would fail. This retries up to 60 times
with a 250 ms pause — a bounded wait of about 15 seconds — and then throws with the URL and the last error.

**Two details that matter:**

**The loop is bounded**, so a server that never comes up produces a clear failure rather than an infinite hang. A retry loop
with no limit is a hang with extra steps.

**`lastError` is remembered and reported.** So the final error says *why* the connection failed — a refused connection, a
protocol mismatch, a timeout — rather than only that it did. That is the difference between a debuggable failure and a
mystery.

The 250 ms interval is a compromise: fast enough that a healthy spawn is not delayed noticeably, slow enough that 60
attempts do not hammer a starting process.

**Block 6 — the host's graph, built the same way twice (lines 119–165).**

```ts
async function main(): Promise<void> {
  const { spawned, stop } = await ensureServer(() =>
    createMcpClient({ url: env.MCP_SERVER_URL, logger: log, metrics }),
  );

  if (spawned) {
    console.log(`   (started the MCP server at ${env.MCP_SERVER_URL})`);
  }

  const client = await connectWithRetry();

  // The host's own graph — the same objects `routes/index.ts` builds.
  const catalogue = createResourceCatalogue();

  const policy = createHostPolicy({ … requestConsent, logger: log });
  const budget = createContextBudget({ … });
  const selection = createSelectionService({ catalogue });
  const audit = createAuditLog(log);

  const deps: HostDeps = { client, policy, selection, budget, audit, logger: log, metrics, limits: { … } };
```

**The comment is the claim: *the same objects `routes/index.ts` builds.*** Six factories, the same six arguments, and the
same `HostDeps` object — because the walkthrough *is* a host, differing only in its interface. So the behaviour this file
demonstrates is the behaviour the HTTP API has, not a parallel implementation that could drift.

The one difference is `requestConsent`: `routes/index.ts` passes a handler that denies by default (Chapter 25), while this
file passes the scripted one from Block 3. That is the injection point doing its job — the policy is identical, and only
the *answer* differs.

Note `spawned` is only used for a console message. The walkthrough reports whether it started the server, so a reader knows
whether the boot line in the transcript came from this run or from a server already running — a small piece of honesty about
what the output means.

**Block 7 — step 1, handshake (lines 167–179).**

```ts
const capabilities = client.raw.getServerCapabilities() ?? {};
const version = client.raw.getServerVersion();

console.log("\n1. handshake   -> capabilities are negotiated, not guessed");
console.log(`   server       ${version?.name ?? "?"} v${version?.name === undefined ? "?" : (version.version ?? "?")}`);
console.log(`   capabilities ${Object.keys(capabilities).sort().join(", ")}`);
console.log(`   instructions ${clip(client.raw.getInstructions() ?? "(none)", 140)}`);
console.log(`   model        ${hasModelKey ? env.OPENAI_MODEL : "offline — the pipeline runs without one, and that is a feature"}`);
```

**`capabilities are negotiated, not guessed`** — the step's own title, and the reason it uses `client.raw` (Chapter 19's
escape hatch) rather than a wrapped method. The three values come from the SDK's handshake state, so this prints what was
*actually agreed* rather than what the host assumed.

**`Object.keys(capabilities).sort()`** — sorted, so the output is deterministic and diffable across runs. And note the
capability keys are the protocol's own: `resources`, `tools`, `prompts` — three, which is the shape `ServerDeps`
(Chapter 13) exists to declare.

**The `model` line is the most quotable:**

```text
model        offline — the pipeline runs without one, and that is a feature
```

*"and that is a feature"* is doing real work. A reader seeing `offline` might read it as a limitation; the line states that
the model-free pipeline is the design being demonstrated. That is the same claim Chapter 22's header makes, reported at
step 1 so it frames the entire run.

**Block 8 — step 2, the policy review (lines 181–190).**

```ts
const tools = await client.listTools();
const review = policy.review(tools);
const visible = policy.visible(tools);

console.log(`\n2. tools/list  -> ${tools.length} discovered, ${visible.length} shown to the model`);
for (const row of review) {
  console.log(`   ${row.tier.padEnd(8)} ${row.name.padEnd(15)} ${row.reason}`);
}
```

**Three lines, and they separate two things the policy could have conflated:** `review` is every tool with its tier and
reason; `visible` is the subset the model will see. So the count line reports *both* numbers — `4 discovered, 4 shown` by
default, `4 discovered, 3 shown` with destructive tools denied — which is what makes the `denied` tier observable rather
than merely implemented (Chapter 20's verify section).

`padEnd(8)` and `padEnd(15)` align the columns, so the reasons line up and the table is readable as a table.

**Block 9 — step 3, the same payload and two owners (lines 192–204).**

```ts
const toolCall = await client.callTool("list_tasks", {});
const toolText = textOf(toolCall);
const backlog = await client.read("task://backlog");

console.log("\n3. intent      -> list_tasks (Tool) and task://backlog (Resource), side by side");
console.log(`   tools/call list_tasks      -> ${clip(toolText.replace(/\n/g, " "), 100)}`);
console.log(`   resources/read task://backlog -> ${clip(backlog.text.replace(/\n/g, " "), 100)}`);
console.log(
  `   identical payloads: ${toolText === backlog.text ? "YES — the same bytes" : "NO — the renderers have drifted"}.` +
    " The difference is who decided to fetch them, not what came back.",
);
```

**This is the lecture's central demonstration, in eleven lines of code and three lines of output.**

`list_tasks` is a **Tool**, called by a model; `task://backlog` is a **Resource**, read by the application. Both reach the
same data, and the assertion is a strict string comparison:

```ts
toolText === backlog.text
```

**`===` on the whole payload**, not a field-by-field check — because the claim is not that the two agree on substance, it is
that they are *the same bytes*. And the failure message names the consequence of a mismatch: *"NO — the renderers have
drifted"*. So the assertion is also a **regression test on the renderer** — one function, `renderBacklog`, reachable two
ways (Chapter 10's `taskService` + `resourceService` sharing), and if either path were given its own renderer, this line would
catch it.

The closing sentence is the lesson, and it is worth reading twice:

> **The difference is who decided to fetch them, not what came back.**

*Who decided* is the whole content model of Lecture 15. A Tool is fetched because a **model** judged it necessary; a Resource
is fetched because the **application** judged it relevant. The bytes are identical; the agency is not. That is why the two are
separate primitives rather than one, and this step is where the distinction stops being an abstraction.

**`textOf(toolCall)`** is Chapter 19's content extractor, and it is the same function the two controllers import
(Chapter 25). So this step also demonstrates the *client*'s uniform return shape: a tool result and a resource read are
different wire shapes, and `textOf`/`read` normalise them.

**`replace(/\n/g, " ")`** flattens newlines for the one-line display, so the two payloads can be compared side by side
visually as well as programmatically.

**Block 10 — step 4, discovery is not consumption (lines 206–216).**

```ts
const { resources, templates } = await client.listResources();

console.log("\n4. resources/list -> metadata only: the client knows what exists, not what it says");
for (const resource of resources) {
  console.log(`   ${resource.uri.padEnd(30)} ${clip(resource.description ?? "", 70)}`);
}
for (const template of templates) {
  console.log(`   ${template.uriTemplate.padEnd(30)} (template) ${clip(template.description ?? "", 60)}`);
}
```

**The step's title is the lesson: *metadata only: the client knows what exists, not what it says.*** And the output
proves it — nine lines of URIs and descriptions, and **no content**. A reader can see that `resources/list` answered a
complete question about the catalogue without reading a single body.

That is Chapter 03 §3.1's split, demonstrated by what the step does *not* print. Templates are marked `(template)` so the
reader can tell the two kinds apart at a glance — and the marker is generated from the loop's own structure (`resources` vs
`templates`) rather than from inspecting the string, which is the same discipline as Chapter 21's machine-generated fences.

**Block 11 — step 5, three shapes through one verb (lines 218–229).**

```ts
const guidelines = await client.read("task://guidelines");
const project = await client.read("task://projects/fde");
const taskDoc = await client.read("task://tasks/1");

console.log("\n5. resources/read -> static, templated and JSON, all through one verb");
console.log(`   task://guidelines        STATIC    ${guidelines.chars} chars, ${guidelines.mimeType}`);
console.log(`   task://projects/fde      TEMPLATE  ${project.chars} chars`);
console.log(indent(clip(project.text.replace(/\n/g, " | "), 110)));
console.log(`   task://tasks/1           TEMPLATE  ${taskDoc.chars} chars, ${taskDoc.mimeType}`);
console.log(indent(clip(taskDoc.text.replace(/\s+/g, " "), 110)));
```

**Three reads, three shapes, one verb** — Chapter 10's six renderers reduced to the three shapes the lecture names:

| URI | Shape | Rendered as |
| :--- | :--- | :--- |
| `task://guidelines` | **STATIC** | Prose |
| `task://projects/fde` | **TEMPLATE** | A project brief |
| `task://tasks/1` | **TEMPLATE** | JSON |

So `resources/read` is shape-agnostic at the protocol level: the client asks for a URI and receives text plus a `mimeType`.
That is what makes a Resource usable for prose, a brief and structured data without three verbs — and it is why the renderer
is the interesting part of Chapter 10 rather than the transport.

**Two different flattenings for the two samples**, and the difference is deliberate: the project brief uses
`replace(/\n/g, " | ")` (line separators, preserving structure), while the JSON uses `replace(/\s+/g, " ")` (collapse all
whitespace, because pretty-printed JSON has indentation that would waste the 110-character budget). **The formatting is
tuned per shape** — which is exactly the point being made.

**Block 12 — step 6, failures are protocol errors (lines 231–242).**

```ts
console.log("\n6. failures    -> a missing Resource is a protocol error, not an isError result");

for (const uri of ["task://tasks/999", "task://nope", "file:///etc/passwd"]) {
  try {
    await client.read(uri);
    console.log(`   ${uri.padEnd(24)} -> unexpectedly succeeded`);
  } catch (error) {
    console.log(`   ${uri.padEnd(24)} -> ${clip((error as Error).message, 90)}`);
  }
}
```

**Three bad URIs, and the title states the asymmetry that Chapter 05's taxonomy exists for:** a Resource failure is a
**protocol error**, while a Tool failure is an `isError` *result*. So the Resource path throws and the Tool path returns.

The three URIs are chosen to exercise three different refusals:

| URI | Refusal | Where it is refused |
| :--- | :--- | :--- |
| `task://tasks/999` | The renderer refused — no such task | **The server** — `NOT_FOUND` |
| `task://nope` | Not in the catalogue | **The client's SDK router** |
| `file:///etc/passwd` | Scheme not served at all | **The client's SDK router** |

**The third is the security-relevant one, and the output is more interesting than the obvious reading.** `file:///etc/passwd`
is a well-formed URI pointing at a real file, and it is refused — but the refusal message is
`Resource not found: file:///etc/passwd`, which is a **NOT_FOUND**, not the `FORBIDDEN` the scheme allowlist (Chapter 20)
would produce.

The reason is the layer that got there first: **the SDK's resource router only matches URIs against the registered
templates**, and `file://` matches none of them. So the refusal never reaches `HostPolicy.mayRead`'s scheme check at all.

That is worth stating precisely, because it is the honest version of a security claim:

| Layer | What it would answer | Did it run? |
| :--- | :--- | :--- |
| The SDK's URI router | *No registered template matches* → NOT_FOUND | **Yes** — it refused first |
| `policy.mayRead`'s scheme allowlist | *This deployment does not serve `file:`* → FORBIDDEN | **No** — never reached |

So the scheme allowlist is **defence in depth, not the first gate** — and in this deployment it is unreachable, because the
router rejects the scheme before the policy is consulted. That is a good position to be in (two independent refusals, the
earlier one stricter) and a bad position to *claim* without checking. The verify section below shows the evidence: the server
logs a `resource.failure` warning for `task://tasks/999` but **not** for the other two, which proves those two never left
the client.

**The `try/catch` prints the message rather than asserting a throw.** So the step reports what *did* happen — including
`unexpectedly succeeded` if a refusal ever stopped working. A test that asserted a throw would fail loudly; this reports
loudly, which is the right behaviour for a walkthrough (a demo that aborts at step 6 tells you less than one that continues
and names the anomaly).

**Block 13 — step 7, the ACL (lines 244–258).**

```ts
console.log("\n7. the ACL     -> the same URI, judged by three different sessions");
for (const actor of [
  { ...session },
  { actor: "456", projects: ["media"], isAdmin: false },
  { ...session, isAdmin: true },
]) {
  const decision = policy.mayRead("user://456/profile", actor);

  console.log(
    `   actor ${actor.actor.padEnd(5)} admin=${String(actor.isAdmin).padEnd(5)} -> ` +
      `${decision.allowed ? "ALLOWED" : "REFUSED"}  ${decision.reason}`,
  );
}
```

**One URI, three sessions, two different answers** — the demonstration Chapter 20's verify section analysed. Three details
make it a good demo:

**The URI is a literal and the sessions vary.** So the output cannot be explained by the address changing; the only variable
is the identity. That is what makes it an ACL rather than a URI check.

**`{ ...session }` spreads the module-level session**, so row 1 and row 3 differ by exactly one field (`isAdmin`) — which
makes the third row's flip attributable to that field and nothing else.

**`decision.reason` is printed alongside the verdict**, so each row says *why*. Row 1's reason names both facts —
*"belongs to another user **and** the session is not an admin"* — telling the reader there were two ways this could have been
allowed.

And note the third session is `{ ...session, isAdmin: true }` with `actor: "123"` — so an admin reading `user://456/profile`
is allowed even though it is not their own profile. That is the `session.isAdmin` branch, and it is the row that proves the
check is an ACL rather than an ownership test.

**Block 14 — step 8, selection with reasons (lines 260–299).**

```ts
const queries = [
  "what is on my plate",
  "how busy am I?",
  "plan my day",
  "show me task 2",
  "what should I do in project media",
];

for (const query of queries) {
  const result = await selection.select({
    message: query,
    scope: { userId: session.actor, projects: session.projects, isAdmin: session.isAdmin },
    limit: env.MCP_MAX_RESOURCES_PER_REQUEST,
  });

  const picks = result.chosen.map((chosen) => `${chosen.uri} ← ${chosen.strategy}`).join("; ") || "(none)";

  console.log(`   "${query}"`);
  console.log(`      strategies=[${result.strategies.join(", ")}] candidates=${result.candidates}`);
  console.log(`      chosen: ${picks}`);
}
```

**Five queries, chosen so that different strategies fire.** That is the design of the list: `"how busy am I?"` should
reach `retrieval`, `"plan my day"` should reach `rule`, `"show me task 2"` should reach `rule` (the id pattern) or `retrieval`,
and `"what should I do in project media"` should reach `state` or `retrieval`. So the five queries are a **matrix over the
strategies**, which is what makes step 8 a demonstration rather than an example.

**Three lines per query, and the third is the point:**

```text
"how busy am I?"
   strategies=[state, retrieval] candidates=3
   chosen: task://projects/fde ← state; task://summary ← retrieval; task://guidelines ← retrieval
```

And the strategies genuinely vary by query, which is what makes the five a matrix:

| Query | `strategies` | Top choice |
| :--- | :--- | :--- |
| `"what is on my plate"` | `[state, retrieval]` | `task://projects/fde ← state` |
| `"how busy am I?"` | `[state, retrieval]` | `task://projects/fde ← state` |
| `"plan my day"` | `[state, retrieval]` | `task://projects/fde ← state` |
| `"show me task 2"` | `[state, rule, retrieval]` | `task://tasks/2 ← rule` |
| `"what should I do in project media"` | `[state, rule, retrieval]` | `task://projects/media ← rule` |

**The `rule` strategy only fires for the two queries that name a specific thing** — `"task 2"` and `"project media"` — which
is Chapter 12's rule strategy matching an id in the message. And `state` fires in every row, because the session is scoped
to project `fde`. So the table is a readable demonstration of *which strategy does what*, and the two `rule` rows are the
ones that prove a pattern match outranks a similarity score.

The `strategies=[…]` line reports **which of the five fired**, and the `chosen:` line pairs each URI with the strategy that
picked it. So the reader can see *why* a Resource was chosen, not just that it was — which is Chapter 12's provenance reaching
the output.

**`|| "(none)"`** handles the empty selection, so a query that matched nothing prints `chosen: (none)` rather than a blank
line — the same stated-absence principle as Chapter 21's empty case.

**`scope` is translated here exactly as `assembleContext` does it** (Chapter 21): `session.actor` → `userId`,
`session.projects` → `projects`. So this step calls the selection engine with the same inputs the real pipeline does.

**Then strategy 1 gets its own demonstration:**

```ts
const attached = await selection.select({
  message: "show me task 2",
  attached: ["task://summary"],
  scope: { … },
  limit: env.MCP_MAX_RESOURCES_PER_REQUEST,
});

console.log('   "show me task 2" + the user attached task://summary');
console.log(
  `      strategies=[${attached.strategies.join(", ")}] top=${attached.chosen[0]?.uri} ` +
    `(score ${attached.chosen[0]?.score}) — an explicit choice beats every guess`,
);
```

The comment explains why strategy 1 is separated out: *an explicit choice. It outranks every inference, which is why it
scores 1 and why the chapter calls it the highest-quality strategy.* So the same query is run twice — once alone, once with
an attachment — and the difference in `top` and `score` is the demonstration. **`score 1`** is the visible form of "the user
said so", and printing the score is what makes it checkable.

**Block 15 — step 9, the budget with all three caps biting (lines 301–323).**

```ts
// A deliberately tiny budget, so the three caps all bite at once.
const tight = createContextBudget({ maxResources: 2, maxResourceChars: 120, maxContextChars: 200 });
const fit = tight.fit([
  { uri: "task://guidelines", strategy: "state", text: guidelines.text },
  { uri: "task://backlog", strategy: "retrieval", text: backlog.text },
  { uri: "task://summary", strategy: "retrieval", text: "x".repeat(500) },
]);

console.log(`   limits ${JSON.stringify(tight.limits)}`);
console.log(`   kept ${fit.blocks.length} block(s), ${fit.usedChars} chars, dropped [${fit.dropped.join(", ")}]`);

for (const block of fit.blocks) {
  console.log(
    `      ${block.uri.padEnd(20)} truncated=${String(block.truncated).padEnd(5)} ${block.originalChars} -> ${block.text.length} chars`,
  );
}

console.log(indent(clip(fit.blocks[0]?.text.slice(-100) ?? "", 100)));
```

**A `tight` budget is built *inside the step*, separate from `deps.budget`.** That is the right way to demo a limit: the
configured budget is 40,000 characters and would never bite on this data, so the step constructs its own with
`maxResources: 2, maxResourceChars: 120, maxContextChars: 200` — all three small enough to trigger.

**Three deliberately-shaped inputs**, and each is chosen to trigger a specific cap:

| Block | Size | What it triggers |
| :--- | :--- | :--- |
| `task://guidelines` | Real prose | The **per-body** cap (120) |
| `task://backlog` | Real prose | Possibly the **total** cap (200) |
| `task://summary` | **500 chars of `"x"`** | The **count** cap (2) — it is third |

**`"x".repeat(500)` is the neat trick.** A synthetic block of known size, so the demo does not depend on how long a real
resource happens to be — and being third, it is dropped by the count cap before the character caps even matter. So the step
exercises the caps in their documented order (count → per-body → total) without the output depending on the task data.

**The loop prints `originalChars -> text.length`**, which is what makes truncation *visible*: a reader sees `260 -> 120` and
knows exactly what was cut. That is Chapter 06's `BudgetedBlock` design paying off — the block reports what it *was*, not
only what it became.

**And the last line prints the marker:**

```ts
console.log(indent(clip(fit.blocks[0]?.text.slice(-100) ?? "", 100)));
```

*The marker is the point: the model is **told** it received a fragment.* So the step does not merely show that truncation
happened — it shows the sentence the model would read, which is the difference between a budget and a silent data loss.
`slice(-100)` takes the **end** of the block, which is where the marker is appended.

**Block 16 — step 10, a template and not an answer (lines 325–355).**

```ts
const promptList = await client.listPrompts();

console.log(`\n10. prompts/list -> ${promptList.length} workflows, each advertising its own arguments`);
for (const prompt of promptList) {
  const args = (prompt.arguments ?? []).map((arg) => `${arg.name}${arg.required === true ? "" : "?"}`).join(", ");
  console.log(`   ${prompt.name}(${args})`);
  console.log(`      ${clip(prompt.description ?? "", 100)}`);
}

const rendered = await client.getPrompt("plan_day", { availableHours: "4" });
const promptMessages = rendered.messages.map((message) => ({
  role: message.role as "user" | "assistant",
  text: textOf({ content: [message.content] }),
}));

console.log("    prompts/get plan_day { availableHours: 4 } -> the messages, and nothing else");
console.log(indent(clip(promptMessages.map((message) => message.text).join(" "), 200)));
console.log("    no model was called. That is Notes Ch07 §7.3, and it is why this step is testable.");
```

**`${arg.name}${arg.required === true ? "" : "?"}` is a compact argument notation** — `availableHours` for required,
`hours?` for optional. So one line per prompt shows the whole signature:

```text
plan_day(availableHours)
review_workload()
weekly_plan(project, startDate?)
```

A reader can see at a glance which prompts take arguments and which are optional — `review_workload` takes **none**, and
`startDate` is optional while `project` is not. That is Chapter 06's argument advertisement made visual, and it is generated
from the server's `prompts/list` response rather than from a table here, so it cannot drift from the validator.

**`promptMessages` is captured here for step 11** — the same conversion the two controllers do (Chapter 25):
`textOf({ content: [message.content] })`. So step 10's output is not just a display; it produces the input the next step's
`assembleContext` call receives. **The steps are genuinely sequential**, which is why this is a walkthrough rather than a
list of independent examples.

**And the closing line is the file's most direct statement of a claim:**

> `no model was called. That is Notes Ch07 §7.3, and it is why this step is testable.`

*Why this step is testable* — because `prompts/get` is deterministic. Given a name and arguments, it returns the same
messages every time, so a test can assert on them. A model call would not be. **The testability is the argument for the
primitive boundary**, stated in the output where a reader will see it.


**Block 17 — step 11, the end-to-end request (lines 357–401).**

```ts
const context = await assembleContext(
  { message: "Plan my day with 4 hours available.", session, promptMessages },
  {
    client,
    policy,
    selection,
    budget,
    logger: log,
    metrics,
    maxResourcesPerRequest: env.MCP_MAX_RESOURCES_PER_REQUEST,
  },
);

const reply = await askModel({
  system: context.system,
  messages: context.messages,
  logger: log,
  metrics,
});

console.log("\n11. GET /plan?hours=4 -> one request, three primitives, three owners");
console.log("   USER      -> prompts/get plan_day { availableHours: 4 }");
console.log(
  `   APP       -> selected [${context.selection.strategies.join(", ")}] ` +
    `${context.included.join(", ")} (${context.chars} chars of ${env.MCP_MAX_CONTEXT_CHARS})`,
);
console.log(
  `   MODEL     -> ${reply.source === "model" ? reply.model : "offline: no key, so the assembled request is echoed"}`,
);
console.log(indent(clip(reply.text.replace(/\n+/g, " "), 230)));
```

**Two calls and five lines of output, and the whole lecture is in the output.** `assembleContext` and `askModel` are the
same two functions `planController` calls (Chapter 25), so step 11 *is* `GET /plan?hours=4` — with the intermediate state
printed instead of serialised into a response body.

**The three `USER`/`APP`/`MODEL` lines are the lecture's architecture in three lines**, and each names the owner before the
fact:

| Line | Owner | What they decided |
| :--- | :--- | :--- |
| `USER -> prompts/get plan_day { availableHours: 4 }` | The user | Which workflow, with which arguments |
| `APP -> selected [state, retrieval] …` | The application | Which Resources to read |
| `MODEL -> offline: …` | The model | Whether to call a tool |

**`${context.chars} chars of ${env.MCP_MAX_CONTEXT_CHARS}`** reports the budget usage as a fraction of the cap — so a
reader sees *635 of 40000*, which is the same "is it worth the tokens?" question Chapter 21's log line answers.

**The `MODEL` line reports the offline state as a *branch*, not a failure:** `offline: no key, so the assembled request is
echoed`. So the third line is honest about which of the three owners did not act — which is exactly the honesty
`planController`'s step 3 also provides.

**Then the four `audit.record` calls that make step 12 meaningful:**

```ts
for (const chosen of context.selection.chosen) {
  audit.record({
    actor: session.actor,
    action: "resource",
    target: chosen.uri,
    decision: "allowed",
    outcome: "ok",
    args: { uri: chosen.uri },
    durationMs: 0,
    note: `${chosen.strategy}: ${chosen.reason}`,
  });
}
```

**One record per chosen URI, and the note carries the strategy and the reason.** So the audit trail answers *"why did the
model know that?"* (Chapter 22's framing) with the selection's own justification. The `durationMs: 0` is honest for a step
whose timing was not measured separately — and the audit record's job is correlation, not profiling.


**Block 18 — step 12, the audit table (lines 403–430).**

```ts
const toolTier = review.find((row) => row.name === "list_tasks")?.tier ?? "auto";

audit.record({
  actor: session.actor,
  action: "tool",
  target: "list_tasks",
  decision: toolTier,
  outcome: "ok",
  args: {},
  durationMs: 0,
  note: "read-only, auto-approved",
});

console.log("\n12. audit      -> who asked for what, what the host decided, and how it ended");
console.log(
  `   ${"time".padEnd(13)}${"action".padEnd(10)}${"target".padEnd(24)}${"decision".padEnd(10)}${"outcome".padEnd(9)}${"argsHash".padEnd(18)}ms`,
);

for (const record of audit.entries()) {
  console.log(
    `   ${record.at.slice(11, 23).padEnd(13)}${record.action.padEnd(10)}${record.target.padEnd(24)}` +
      `${record.decision.padEnd(10)}${record.outcome.padEnd(9)}${record.argsHash.padEnd(18)}${record.durationMs}`,
  );
}

console.log("   (arguments are hashed, never stored; resource content is never recorded at all)");
```

**The tool record reuses the tier step 2 computed** — `review.find((row) => row.name === "list_tasks")?.tier` — rather than
hard-coding `"auto"`. So the audit record's `decision` is the *policy's* answer, not a literal, and the `?? "auto"` fallback
covers a `list_tasks` that was somehow absent from the review. That is the difference between recording a decision and
recording a copy of one.

**The table is printed with `padEnd` and a manual header**, and two details are worth noting:

**`record.at.slice(11, 23)`** takes characters 11–23 of an ISO timestamp — the time portion only, `21:24:03.632`. The date
is omitted because a single run's records all share one, and the milliseconds are kept because sub-second ordering is the
whole reason the records are useful in sequence.

**`record.durationMs` is not padded** — it is the last column, so alignment does not matter and a number needs no padding.

**And the closing line is the omission, stated:**

```text
(arguments are hashed, never stored; resource content is never recorded at all)
```

That sentence is printed *under the table*, so a reader looking at five `argsHash` values is told what they are and what is
missing — which is the only way an audit trail's privacy properties are discoverable from its output.



**Block 19 — step 13, the metrics (lines 432–438).**

```ts
console.log("\n13. metrics    -> the numbers a dashboard would scrape");

for (const [name, value] of Object.entries(metrics.snapshot())) {
  console.log(`   ${name.padEnd(40)} ${value}`);
}
```

**Three lines, and the last step is deliberately the least interesting.** `Object.entries(metrics.snapshot())` prints
whatever was collected — the walkthrough does not enumerate metric names, because `createMetrics` (Chapter 04) accepts
arbitrary ones and any hard-coded list would drift.

*"the numbers a dashboard would scrape"* is the framing: these are the same numbers `/metrics` serves (Chapter 25), so
step 13 and the HTTP route show the same data. And note the walkthrough's `metrics` object is the one passed to the client,
so one snapshot covers **both layers**:

```text
client.callTool.ms.avg                   30     ← protocol: the wire round trips
client.getPrompt.ms.avg                  4
client.listPrompts.ms.avg                5
client.listResources.ms.avg              6
client.listResourceTemplates.ms.avg      5
client.listTools.ms.avg                  15
client.readResource.ms.avg               6      count 10  max 9
context.assembled                        1      ← pipeline: the host's own reasoning
context.chars.avg                        635
context.chars.count                      1
context.chars.max                        635
model.skipped                            1
```

**Two families, one snapshot.** The `client.*` metrics come from `createMcpClient` (Chapter 19) and measure the *transport*;
`context.*` and `model.skipped` come from the host's own code (Chapters 21–22) and measure the *reasoning*. So a single
scrape answers both *"is the server slow?"* and *"is our context budget sensible?"* — which are different questions asked by
different people.

**`client.readResource.ms.count 10`** is the number to notice: ten reads across the whole walkthrough (steps 3, 5, 6's one
successful refusal attempt, and step 11's three) — and step 11's three logged `source: "cache"`, so the TTL cache from
Chapter 10 served them. The metric counts the *calls*, not the renderers, which is exactly the distinction that makes a cache
measurable.

**`context.chars.avg 635` with `count 1`** — one observation, so the average is just the value. In a long-running host that
average is the interesting number: it tells you how much context a typical request actually uses, which is what turns *"the
budget felt right"* into a measurement.

**Block 20 — teardown and the direct-execution guard (lines 439–456).**

```ts
} finally {
  await client.close();
  stop();
}

console.log("\ndone.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
```

**`finally` rather than a normal path**, so the client is closed and the server stopped whether the walkthrough completed or
threw at step 4. Without it, a mid-run failure would leave an orphaned server holding port 8081 — and the next run's probe
would find it and connect to a stale process.

**`stop()` after `client.close()`, and the order is the same as `routes/index.ts`** (Chapter 25): close the session, then
the process. So both hosts tear down in the same sequence.

**The direct-execution guard** — `import.meta.url === pathToFileURL(process.argv[1]).href` — is the ESM replacement for
`require.main === module`. So `main()` runs only when the file is executed directly, which means `lifecycle.ts` can be
imported by a test without spawning a server. And `process.argv[1] &&` guards the case where there is no script argument at
all.

**The failure path is `process.exit(1)`, and the comment explains why not `process.exitCode`:**

> A demo CLI must fail **loudly and promptly**: `process.exitCode` alone would leave the spawned server's pipe open, so the
> shell would sit there waiting for a process that has nothing left to do.

That is a real CLI hazard. Setting `exitCode` lets the event loop drain, and a spawned child with `stdio: "inherit"` keeps a
pipe open — so the shell hangs after an error instead of returning a prompt. `process.exit(1)` terminates immediately, which
for a demo tool is the right trade: a fast, obvious failure beats a tidy one that never arrives.

`console.error(error)` rather than a formatted message, so the stack is visible — this is a developer tool, and the audience
can read a stack trace.

---

## Run / verify

### 1. The whole run, and its exit code

```bash
npm run lifecycle 2>/dev/null; echo "exit=$?"
```

```text
exit=0
```

**Thirteen steps, exit 0.** The `2>/dev/null` splits the two streams deliberately: the *printed walkthrough* goes to stdout
and the *log lines* go to stderr, so a reader can see either independently. That split is what makes
`npm run lifecycle 2>/dev/null` a readable transcript and `npm run lifecycle 2>&1 >/dev/null` a log stream.

### 2. Step 3 — the claim the lecture rests on

```bash
npm run lifecycle 2>/dev/null | sed -n '/^3\./,/^4\./p'
```

```text
3. intent      -> list_tasks (Tool) and task://backlog (Resource), side by side
   tools/call list_tasks      -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) - [normal] Review pull request  …(+91)
   resources/read task://backlog -> Open tasks: 3  - [high] Write MCP notes  (project: fde, owner: 123) - [normal] Review pull request  …(+91)
   identical payloads: YES — the same bytes. The difference is who decided to fetch them, not what came back.
```

**`identical payloads: YES — the same bytes.`** One renderer (`renderBacklog`, Chapter 10), two owners: a **Tool** called by
a model, a **Resource** read by the application. The assertion is `toolText === backlog.text` — a whole-payload string
comparison — so this line is simultaneously the lecture's demonstration and a regression test on the renderer.

The two payloads are visibly byte-identical, including the same `…(+91)` clip suffix, because `clip` was applied to the same
input. **The difference is who decided to fetch them, not what came back.**

### 3. Step 6 — and a security claim checked rather than assumed

```bash
npm run lifecycle 2>/dev/null | sed -n '/^6\./,/^7\./p'
```

```text
6. failures    -> a missing Resource is a protocol error, not an isError result
   task://tasks/999         -> No task with id 999.
   task://nope              -> Resource not found: task://nope
   file:///etc/passwd       -> Resource not found: file:///etc/passwd
```

**Three refusals, and the messages reveal which layer produced each** — which is the check that corrects an easy assumption:

| URI | Message | Refused by |
| :--- | :--- | :--- |
| `task://tasks/999` | `No task with id 999.` | **The server's renderer** — a `NOT_FOUND` with a *task-specific* message |
| `task://nope` | `Resource not found: task://nope` | **The client's SDK router** — a generic not-found |
| `file:///etc/passwd` | `Resource not found: file:///etc/passwd` | **The client's SDK router** |

The distinction is in the wording: the first message names the *task*, so it came from the renderer; the other two are
generic, so they came from the router before any renderer ran. **So `file:///etc/passwd` is refused by the SDK's URI
matcher — not by `policy.mayRead`'s scheme allowlist**, which would have produced a `FORBIDDEN`.

The proof is in the server's log — one `resource.failure` for the URI that reached it, and none for the two that did not:

```bash
npm run lifecycle 2>&1 >/dev/null | grep resource.failure
```

```json
{"event":"resource.failure","server":"task-mcp-server","uri":"task://tasks/999","code":"NOT_FOUND","message":"No task with id 999."}
```

**One line.** No entry for `task://nope` and none for `file:///etc/passwd`, because those never left the client. So the
scheme allowlist is **defence in depth that this deployment never reaches** — a good position, and a bad claim to make
without checking. (Chapter 20's `mayRead` still has the check, and it is what would answer if the SDK ever routed a `file:`
URI.)


### 4. Step 7 — the ACL, three sessions

```bash
npm run lifecycle 2>/dev/null | sed -n '/^7\./,/^8\./p'
```

```text
7. the ACL     -> the same URI, judged by three different sessions
   actor 123   admin=false -> REFUSED  "user-profile" belongs to another user and the session is not an admin
   actor 456   admin=false -> ALLOWED  "user-profile" belongs to the session's own user
   actor 123   admin=true  -> ALLOWED  session is an admin, so "user-profile" is readable
```

**One URI (`user://456/profile`), three sessions, two answers** — and every row reaches its answer through a *different*
check, which is why the reasons differ. Row 1's reason names **both** facts (*belongs to another user **and** the session is
not an admin*), telling the reader there were two ways this could have been allowed.

### 5. Step 8 — the strategy matrix

```bash
npm run lifecycle 2>/dev/null | sed -n '/^8\./,/^9\./p'
```

```text
8. selection   -> the application chooses, and every choice carries its reason
   "what is on my plate"
      strategies=[state, retrieval] candidates=2
      chosen: task://projects/fde ← state; task://backlog ← retrieval
   "how busy am I?"
      strategies=[state, retrieval] candidates=3
      chosen: task://projects/fde ← state; task://summary ← retrieval; task://guidelines ← retrieval
   "plan my day"
      strategies=[state, retrieval] candidates=2
      chosen: task://projects/fde ← state; task://guidelines ← retrieval
   "show me task 2"
      strategies=[state, rule, retrieval] candidates=5
      chosen: task://tasks/2 ← rule; task://projects/fde ← state; task://backlog ← retrieval
   "what should I do in project media"
      strategies=[state, rule, retrieval] candidates=5
      chosen: task://projects/media ← rule; task://projects/fde ← state; task://backlog ← retrieval
   "show me task 2" + the user attached task://summary
      strategies=[user, state, rule, retrieval] top=task://summary (score 1) — an explicit choice beats every guess
```

**Five queries, and the `strategies=[…]` line differs between them** — which is what makes this a demonstration rather than
an example. Three observations:

**`rule` fires only for the two queries naming a specific thing** (`"task 2"`, `"project media"`), and in both cases it wins
the top slot — a pattern match outranks a similarity score, which is Chapter 12's ranking working as designed.

**`state` fires in every row**, because the session is scoped to `fde`. That is the same scope that makes step 11 include
`task://projects/fde`, and its absence in a bare `curl` is why Chapter 25's `/plan` output differs.

**The last block adds `user` to the strategies** — `[user, state, rule, retrieval]`, four of the five — and `top` is the
attached URI with **`score 1`**. That is strategy 1's precedence made visible: *an explicit choice beats every guess*, and
printing the score is what makes it checkable rather than merely asserted.

### 6. Steps 12–13, and the closing state

```bash
npm run lifecycle 2>/dev/null | sed -n '/^12\./,$p'
```

```text
12. audit      -> who asked for what, what the host decided, and how it ended
   time         action    target                  decision  outcome  argsHash          ms
   16:40:23.201 prompt    plan_day                allowed   ok       32beeaa846e8d86e  0
   16:40:23.211 resource  task://projects/fde     allowed   ok       23bf90ec7c709d0d  0
   16:40:23.211 resource  task://backlog          allowed   ok       c833edcfbb48c145  0
   16:40:23.211 resource  task://guidelines       allowed   ok       096a7e6630b48696  0
   16:40:23.211 tool      list_tasks              auto      ok       44136fa355b3678a  0
   (arguments are hashed, never stored; resource content is never recorded at all)

13. metrics    -> the numbers a dashboard would scrape
   client.callTool.ms.avg                   30
   ...
   context.chars.avg                        635
   model.skipped                            1

done.
```

**Five audit records, three primitives** — one `prompt`, three `resource`s, one `tool` — and the `decision` column carries
both vocabularies: `allowed` for the prompt and resources, `auto` for the tool. **One request, three primitives, one
table**, which is Lecture 15's widening of the audit record made visible.

And the run ends cleanly: `client.closed` on the host's stream and `server.shutdown` with `signal: "SIGTERM"` on the
server's — because `finally` closed the client and `stop()` signalled the process group (Block 20). **No orphaned server
holding port 8081.**

### 7. The consent gate, verified as absent

```bash
npm run lifecycle 2>&1 >/dev/null | grep -c '"event":"policy.consent"'
```

```text
0
```

**Zero.** The scripted handler in Block 3 is never invoked, because no step calls a `confirm`-tier tool. Its comment claims
*both branches are exercised below* — and they are not. Documented in Block 3 and in Chapter 20 rather than left as an
implied claim.

### 8. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```


---

## Checkpoint

1. **What is `npm run lifecycle` for?**
   It is the same pipeline the HTTP host runs, driven step by step with the intermediate state printed — *the only way to
   see the **control model** rather than its result.* The HTTP API shows an answer; this shows who decided what, and why.

2. **What three parts of a real host does it stand in for?**
   It **starts the server** (a host owns its spawned processes), **answers the consent prompt** deterministically, and
   **prints the audit table and metrics** (what an operator would look at after the fact).

3. **How does `ensureServer` detect whether a server is already running?**
   By opening a real MCP client and closing it — not a port check. A socket check proves something is listening; a handshake
   proves a *protocol-speaking server* is there. Same instinct as `/health`.

4. **Why is the spawned server `detached` and killed with a negative pid?**
   Because `npx tsx src/index.ts` is three processes (npx → tsx → node). A process group lets one signal stop all three;
   killing the wrapper alone would orphan the node process holding port 8081.

5. **What does `clip` add beyond truncation?**
   A **count of what was removed** — `…(+1020)`. *A stated omission is information*: a reader knows exactly how much they
   are not seeing, which is what makes a clipped transcript trustworthy.

6. **What is step 3's assertion, and why is `===` the right comparison?**
   `toolText === backlog.text` on the whole payload. The claim is not that the two agree on substance but that they are
   **the same bytes** — and a mismatch would name the consequence: *the renderers have drifted*.

7. **Which layer refuses `file:///etc/passwd`, and how do you know?**
   The **client's SDK router**, not `policy.mayRead`'s scheme allowlist. The message is the generic `Resource not found:`
   rather than a `FORBIDDEN`, and the server logs a `resource.failure` for `task://tasks/999` but **none** for the `file:`
   URI — so it never left the client. The allowlist is defence in depth that this deployment does not reach.

8. **Why does step 9 build its own `tight` budget instead of using `deps.budget`?**
   Because the configured budget is 40,000 characters and would never bite on this data. A 200-character budget with a
   500-character synthetic block makes all three caps fire, in their documented order.

9. **Why is `"x".repeat(500)` a good test input?**
   A synthetic block of **known size**, so the demo does not depend on how long a real resource happens to be — and being
   third, it is dropped by the count cap before the character caps matter.

10. **Why does step 11 capture `promptMessages` in step 10?**
    Because step 11 passes them into `assembleContext` — the same conversion the controllers do. **The steps are genuinely
    sequential**, which is what makes this a walkthrough rather than a list of examples.

11. **Why does step 12's tool record use `review.find(…)` rather than a literal `"auto"`?**
    So the record's `decision` is the **policy's** answer rather than a copy of one. If the tier changed, the audit trail
    would change with it.

12. **Why `process.exit(1)` rather than `process.exitCode = 1`?**
    Because `exitCode` lets the event loop drain, and a spawned child with `stdio: "inherit"` keeps a pipe open — so the
    shell would hang instead of returning a prompt. *A demo CLI must fail loudly and promptly.*

13. **What is verified about the consent gate, and what is not?**
    The seam is wired and the handler is correct, but it is **never invoked** — `grep -c '"event":"policy.consent"'`
    returns `0`, because no step calls a `confirm`-tier tool. The *demonstration* is missing even though the comment claims
    both branches are exercised.

---

## Where to go next

This is the last chapter, so the honest closing note is about the seams rather than the features.

**Every limit this guide names is a seam, not a wall.** In-process state, a header-based session, a scheme allowlist the
router pre-empts, a consent gate that is wired but untriggered, a route-level 404 with a different body shape — each is
documented where it lives, and each is a change to one file:

| Limit | Where it is documented | The change |
| :--- | :--- | :--- |
| State is in-process | Chapter 07 | Swap `TaskStore`'s arrays for a repository |
| Identity comes from headers | Chapter 24 | Replace `sessionFromHeaders` |
| The scheme allowlist is pre-empted | Chapter 20, this chapter | Already correct — the SDK router is stricter |
| The consent gate is never triggered | Chapter 20, this chapter | Add a step that calls `delete_task` |
| Two 404 body shapes | Chapter 24 | Have `notFound` throw an `AppError` |

**And the two claims worth re-checking on any change:**

```bash
npm run typecheck && npm run lifecycle 2>/dev/null | grep 'identical payloads'
```

If that line still says `YES — the same bytes`, the Tool and Resource paths still share one renderer — which is the
lecture's central demonstration, and the one thing in this project that a careless refactor would break silently.

---

**[← Chapter 25: Controllers & Router](./25_Controllers_and_Router.md)** · **[Back to the guide index](./README.md)**


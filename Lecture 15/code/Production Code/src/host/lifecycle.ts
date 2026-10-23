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

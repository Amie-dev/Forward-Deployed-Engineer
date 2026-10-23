import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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





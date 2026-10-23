import "dotenv/config";
import * as z from "zod/v4";
import { LOG_LEVELS } from "../core/logger.js";

/**
 * Chapter 08 §8.5 — configuration.
 *
 * Every knob this server has is declared once, validated once and typed once.
 * A malformed value must stop the process at boot: a bad timeout discovered
 * three turns into a conversation is an incident, not a typo.
 *
 * The schema is also the documentation — there is no second list of environment
 * variables to keep in sync with this one.
 */

/**
 * `z.coerce.boolean()` would be a trap here, because `Boolean("false")` is
 * `true`. Parsing the two literal strings is the only honest coercion for an
 * environment variable.
 */
const booleanFromEnv = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");

const envSchema = z.object({
  // Identity — Chapter 02: everything a client learns about this server at
  // `initialize`, and the fields a host uses to decide whether to trust it.
  MCP_SERVER_NAME: z.string().min(1).max(64).default("task-mcp-server"),
  MCP_SERVER_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver, e.g. 1.0.0").default("1.0.0"),
  MCP_TRANSPORT: z.enum(["stdio"]).default("stdio"),

  // Observability — Chapter 08.
  MCP_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  // Execution guards — Chapter 08 §"Timeouts, retries and circuit breaking".
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  MCP_MAX_TASKS: z.coerce.number().int().min(1).max(1_000_000).default(1_000),

  // Host policy — Chapter 08 §8.1: discovery is an inventory, not a grant.
  MCP_HOST_ALLOW_DESTRUCTIVE: booleanFromEnv(true),
  MCP_HOST_REQUIRE_CONSENT: booleanFromEnv(true),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Chapter 06 §6.2 — a Resource is *addressable* context, so it needs a scheme.
 *
 * `https://` would only be honest if the client could fetch the URI itself;
 * it cannot. A private scheme keeps the address truthful and stops a host from
 * trying to dereference something it has no business reading.
 */
export const URI_SCHEME = "company";

function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    // Fail fast, fail loudly, and name the exact variable. Written straight to
    // stderr because a stdio server may not have a working stdout yet.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    process.stderr.write(`[config] refusing to start — invalid environment:\n${problems}\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv(process.env);

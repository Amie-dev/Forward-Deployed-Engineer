import "dotenv/config";
import * as z from "zod/v4";
import { LOG_LEVELS } from "../core/logger.js";

/**
 * Notes Ch01 §1.6 / Ch03 §3.5 — configuration.
 *
 * Every knob this server has is declared once, validated once and typed once.
 * A malformed value must stop the process at boot: a bad context cap discovered
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

/**
 * A comma-separated list becomes a trimmed, lower-cased, de-duplicated array.
 *
 * This is the shape a URI-scheme allowlist wants (Notes Ch03 §"URI is an
 * identifier"): a `Set` membership test at the edge of the resource layer, not
 * a chain of `startsWith` calls scattered through the handlers.
 */
const csvFromEnv = (fallback: readonly string[]) =>
  z
    .string()
    .default(fallback.join(","))
    .transform((value) => [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))]);

const envSchema = z
  .object({
    // Identity — Notes Ch01 §1.6: what a client learns at `initialize`.
    MCP_SERVER_NAME: z.string().min(1).max(64).default("task-mcp-server"),
    MCP_SERVER_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver, e.g. 1.0.0").default("1.0.0"),

    // Transport — Notes Ch03: the server and the host are two processes.
    MCP_SERVER_PORT: z.coerce.number().int().min(1024).max(65_535).default(8_081),
    MCP_HOST_PORT: z.coerce.number().int().min(1024).max(65_535).default(8_080),
    MCP_SERVER_URL: z
      .string()
      .refine((value) => /^https?:\/\//.test(value), "must be an http(s) URL, e.g. http://127.0.0.1:8081/mcp")
      .default("http://127.0.0.1:8081/mcp"),

    // Observability.
    MCP_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

    // Execution guards. Two budgets on purpose: `prompts/get` is a local
    // template render, `resources/read` may reach a backend (Notes Ch07).
    MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    MCP_RESOURCE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),

    // Context budgets — Notes Ch02 §"Size and token budget" and Ch05 §"Context
    // budget is the real constraint". Three separate caps, because one huge
    // document and ten small ones are two different failures.
    MCP_MAX_RESOURCES_PER_REQUEST: z.coerce.number().int().min(1).max(20).default(3),
    MCP_MAX_RESOURCE_CHARS: z.coerce.number().int().min(500).max(1_000_000).default(20_000),
    MCP_MAX_CONTEXT_CHARS: z.coerce.number().int().min(500).max(4_000_000).default(40_000),

    // Caching — Notes Ch04 §"Cache like a read-heavy system".
    MCP_RESOURCE_CACHE_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),

    // Resource safety — Notes Ch03 §3.5 / Ch04 §"Validate and constrain".
    MCP_ALLOWED_RESOURCE_SCHEMES: csvFromEnv(["task", "user"]),

    // Domain limits.
    MCP_MAX_TASKS: z.coerce.number().int().min(1).max(1_000_000).default(1_000),

    // Host policy. Discovery is an inventory, not a grant, so a deployment
    // decides what a model may even be shown.
    MCP_HOST_ALLOW_DESTRUCTIVE: booleanFromEnv(true),
    MCP_HOST_REQUIRE_CONSENT: booleanFromEnv(true),
    /** Prompt names this deployment offers. Empty means "every registered prompt". */
    MCP_HOST_ALLOWED_PROMPTS: csvFromEnv([]),

    // The model step — Notes Ch07 §7.3. The key is allowed to be empty; that is
    // what makes the whole project reproducible offline.
    OPENAI_API_KEY: z.string().default(""),
    OPENAI_MODEL: z.string().min(1).max(64).default("gpt-5.4-mini"),
  })
  /**
   * A cross-field rule the schema alone cannot express: a single resource may
   * not be allowed to exceed the total context budget, because that would make
   * the per-resource cap decorative.
   */
  .refine((env) => env.MCP_MAX_RESOURCE_CHARS <= env.MCP_MAX_CONTEXT_CHARS, {
    message: "must not exceed MCP_MAX_CONTEXT_CHARS, or the per-resource cap can never bind",
    path: ["MCP_MAX_RESOURCE_CHARS"],
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    // Fail fast, fail loudly, and name the exact variable. Written straight to
    // stderr because stdout is the protocol channel on a stdio binding.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    process.stderr.write(`[config] refusing to start — invalid environment:\n${problems}\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv(process.env);

/**
 * Notes Ch07 §7.3 — the model call happens *after* `prompts/get`, and it is the
 * only thing in the project that needs a credential. Reporting that fact as a
 * boolean keeps the branch in exactly one place.
 */
export const hasModelKey: boolean = env.OPENAI_API_KEY.trim().length > 0;

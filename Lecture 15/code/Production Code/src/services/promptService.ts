import * as z from "zod/v4";
import { PromptError } from "../core/errors.js";

/**
 * Notes Ch06 §6.3–6.8 — **Prompts**: reusable interaction templates, controlled
 * by the **user**.
 *
 * Three rules from the notes are load-bearing here, and this file is shaped
 * around them:
 *
 *  1. **`MCP Prompt ≠ LLM Response`.** Nothing in this file calls a model, and
 *     nothing in it can: a prompt is a *message template*, and the messages it
 *     returns are the input to a model call that happens somewhere else
 *     (Notes Ch07 §7.3).
 *
 *  2. **A prompt never reads live data.** It may *ask the model* to call a tool;
 *     it must not pre-bake the answer. A prompt that embeds a snapshot of the
 *     board is stale the second after it is fetched, and the model then quotes
 *     yesterday's state with total confidence (Notes Ch06 §6.9).
 *
 *  3. **A prompt should only reference capabilities its own server exposes.**
 *     Every template below names `list_tasks` and the `task://` Resources, which
 *     this same server registers — that is what makes it a *recommended workflow
 *     for this server* rather than a generic wish (Notes Ch07 §7.2).
 *
 * Because a template is a pure function of its arguments, the whole prompt path
 * is **testable without a model** (Notes Ch07 §"Test the prompt path without a
 * model"). That is the practical payoff of rule 1.
 */

export interface PromptMessage {
  role: "user" | "assistant";
  text: string;
}

/** What `prompts/list` advertises about one argument (Notes Ch06 §6.6). */
export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

/**
 * One prompt, declared as data.
 *
 * `argsSchema` is the **single source of truth** for the arguments: the
 * advertised list is derived from it, and `get` validates against it. Keeping a
 * separate hand-written argument list is how a server ends up advertising an
 * argument it then refuses, which is worse than advertising none.
 */
export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  /**
   * Prompt text is a product artefact: changing it changes model behaviour, so
   * the change is versioned and reviewable (Notes Ch06 §"Prompt hygiene").
   */
  version: string;
  argsSchema: z.ZodObject<z.ZodRawShape>;
  render(args: Record<string, string | undefined>): PromptMessage[];
}

export interface PromptSummary {
  name: string;
  title: string;
  description: string;
  version: string;
  arguments: PromptArgument[];
}

export interface PromptRender {
  name: string;
  version: string;
  description: string;
  messages: PromptMessage[];
}

export interface PromptService {
  /** Everything `prompts/list` reports — including each argument's shape. */
  list(): PromptSummary[];
  /** Everything `prompts/get` returns, after validating and substituting. */
  get(name: string, args: Record<string, unknown>): PromptRender;
  /** The raw spec, for a host that wants to render its own menu. */
  byName(name: string): PromptSpec | undefined;
}

/** A one-message prompt: the common case, and the one that reads best. */
const user = (text: string): PromptMessage[] => [{ role: "user", text }];

/**
 * The prompt menu.
 *
 * Three prompts, deliberately — Notes Ch06 §"Keep the count small": *ten
 * excellent workflows beat sixty mediocre ones, because the menu is a product
 * surface.* They are also chosen to cover the three argument shapes a server
 * actually has to handle:
 *
 *   plan_day          one required argument
 *   review_workload   no arguments at all
 *   weekly_plan       one required and one optional
 */
const PROMPTS: readonly PromptSpec[] = [
  {
    name: "plan_day",
    title: "Plan my day",
    description:
      "Build an ordered plan for the tasks already on the backlog, using the hours the user has available. The prompt supplies the instructions; list_tasks supplies the facts.",
    version: "1.0.0",
    argsSchema: z.object({
      availableHours: z
        .string()
        .trim()
        .regex(/^\d{1,2}(\.\d)?$/, "must be a number of hours, e.g. 4 or 7.5")
        .describe("Number of hours available today, e.g. 4"),
    }),
    render: ({ availableHours }) =>
      user(
        [
          "Help me plan my pending tasks for today.",
          "",
          "First read my current pending tasks using the list_tasks tool, then apply the guidelines in the task://guidelines resource.",
          "",
          `I have ${availableHours} hours available today.`,
          "",
          "Give me a concise and ordered plan. Do not invent tasks: every task you mention must have come from list_tasks.",
        ].join("\n"),
      ),
  },
  {
    name: "review_workload",
    title: "Review my workload",
    description:
      "Look at the current backlog and say whether it is realistic, and what to drop first. Takes no arguments, because the question is the same every time it is asked.",
    version: "1.0.0",
    argsSchema: z.object({}),
    render: () =>
      user(
        [
          "Review my current workload.",
          "",
          "Read task://backlog and task://summary, then tell me:",
          "1. whether the total is realistic for one person, and",
          "2. which tasks I should drop or defer first, and why.",
          "",
          "Be specific: name the tasks you would drop, and never mention a task the resources did not return.",
        ].join("\n"),
      ),
  },
  {
    name: "weekly_plan",
    title: "Create weekly plan",
    description:
      "Turn one project's backlog into a week of scheduled work. Takes the project to plan, and optionally the date the week starts.",
    version: "1.0.0",
    argsSchema: z.object({
      project: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9_-]*$/i, "must be a project slug, e.g. fde")
        .describe("Project slug to plan, e.g. fde"),
      startDate: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date, e.g. 2026-10-26")
        .optional()
        .describe("Optional ISO date the week starts on, e.g. 2026-10-26"),
    }),
    render: ({ project, startDate }) =>
      user(
        [
          `Create a weekly plan for the project "${project}".`,
          "",
          `Read task://projects/${project} to get the tasks, and task://guidelines for the rules.`,
          startDate === undefined ? "Assume the week starts today." : `The week starts on ${startDate}.`,
          "",
          "Spread the work across five days, keep at most three high-priority items per day, and say explicitly which tasks did not fit.",
        ].join("\n"),
      ),
  },
];

/**
 * Derives the advertised argument list from the schema.
 *
 * Optionality is probed by parsing `undefined` rather than by inspecting a
 * modifier chain. It is one line, it cannot drift from what `get` will actually
 * do, and it stays correct across schema-library changes — which matters,
 * because a menu that lies about which arguments are required is worse than a
 * menu with no arguments at all.
 */
function argumentsOf(schema: z.ZodObject<z.ZodRawShape>): PromptArgument[] {
  /**
   * `z.ZodRawShape` types its values as the *core* schema, which does not carry
   * the classic surface (`description`, `safeParse`) this derivation needs. The
   * cast names that gap explicitly instead of hiding it behind `any`.
   */
  const shape = schema.shape as Record<string, z.ZodType>;

  return Object.entries(shape).map(([name, field]) => ({
    name,
    description: field.description ?? `The ${name} argument.`,
    required: !field.safeParse(undefined).success,
  }));
}

export function createPromptService(prompts: readonly PromptSpec[] = PROMPTS): PromptService {
  const byName = new Map(prompts.map((prompt) => [prompt.name, prompt]));

  return {
    list: () =>
      prompts.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        version: prompt.version,
        arguments: argumentsOf(prompt.argsSchema),
      })),

    byName: (name) => byName.get(name),

    get(name, args) {
      const spec = byName.get(name);

      if (spec === undefined) {
        // Notes Ch07 §7.4 — fail loudly on an unknown prompt. A silent fallback
        // to a client-side prompt means the server's recommended workflow stops
        // being used and nobody notices.
        throw new PromptError(
          "NOT_FOUND",
          `Unknown prompt: "${name}".`,
          `Call prompts/list to read the available names (${[...byName.keys()].join(", ")}).`,
        );
      }

      const parsed = spec.argsSchema.safeParse(args);

      if (!parsed.success) {
        // The detail names the argument, because the caller is a UI that has to
        // tell a user which field to fix.
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
          .join("; ");

        throw new PromptError(
          "INVALID_INPUT",
          `Invalid arguments for prompt "${name}" — ${detail}.`,
          "Send the arguments exactly as prompts/list advertises them, or omit optional ones.",
        );
      }

      const messages = spec.render(parsed.data as Record<string, string | undefined>);

      if (messages.length === 0) {
        // An empty message list is not a valid prompt result: the caller asked
        // for a workflow and got nothing, which is a bug worth failing on rather
        // than a model call worth making (Notes Ch07 §7.4).
        throw new PromptError(
          "UNAVAILABLE",
          `Prompt "${name}" produced no messages.`,
          "Report this as a server-side bug; do not fall back to an empty model call.",
          { httpStatus: 500 },
        );
      }

      return {
        name: spec.name,
        version: spec.version,
        description: spec.description,
        messages,
      };
    },
  };
}


import * as z from "zod/v4";
import { MIME, type MimeType } from "../config/constants.js";
import { ResourceError } from "../core/errors.js";
import type {
  CatalogueEntry,
  ResolvedResource,
  ResourceCatalogue,
  ResourceDescriptor,
  SearchableEntry,
} from "../domain/resourceCatalogue.js";
import type { Task } from "../domain/taskStore.js";
import { coercePositiveInt, projectId as projectIdSchema, userId as userIdSchema, type TaskService } from "./taskService.js";

/**
 * Notes Ch04 §4.2–4.7 — **the resource layer**: where a Resource stops being a
 * description and becomes bytes.
 *
 * It owns four responsibilities, and keeping them together is the point:
 *
 *  1. **Rendering.** One function per descriptor name, turning typed facts from
 *     `taskService` into the body a URI addresses.
 *  2. **Caching.** Static bodies live for the process; dynamic ones get a TTL
 *     (Notes Ch04 §"Cache like a read-heavy system").
 *  3. **Validation of template variables.** A `{taskId}` of `"abc"` is an
 *     `INVALID_INPUT`, not an empty document (Notes Ch04 §"Validate and
 *     constrain dynamic URIs").
 *  4. **Failing loudly.** An unknown URI is a `ResourceError`, never an empty
 *     string pretending to be content (Notes Ch03 §3.9, failure-mode table).
 *
 * What it does *not* own is the budget. Clipping a body to fit a prompt is a
 * prompt-assembly concern, so it lives in `core/guards.ts` and is applied by the
 * host — a resource read for a user who asked for it is not the same thing as a
 * resource read to be stuffed into a context window.
 */

/** The static body. It lives here because it *is* the Resource (Notes Ch04 §4.2). */
const GUIDELINES = `Task Management Guidelines:

1. Deep work tasks should preferably be done before 12 PM.
2. Meetings should preferably be scheduled after 2 PM.
3. Urgent tasks should be completed on the same day.
4. Keep a maximum of three high-priority tasks per day.
5. Complete high-priority tasks before low-priority tasks.`;

/** One read, after rendering and before any prompt budget is applied. */
export interface ResourceRead {
  uri: string;
  descriptor: ResourceDescriptor;
  mimeType: MimeType;
  text: string;
  /** Where the body actually came from — the honest half of a cache. */
  source: "static" | "live" | "cache";
  /** Characters before any budget clipping. */
  chars: number;
}

export interface ResourceServiceStats {
  cached: number;
  hits: number;
  misses: number;
}

export interface ResourceService {
  /** Read one resource by URI. Throws a `ResourceError` for anything it cannot serve. */
  read(uri: string): ResourceRead;
  /** The entries `resources/list` advertises as instances. */
  list(): CatalogueEntry[];
  /** The descriptors `resources/templates/list` advertises. */
  templates(): readonly ResourceDescriptor[];
  /** What the selector ranks — metadata only, never content. */
  searchable(): readonly SearchableEntry[];
  /** Match a URI to a descriptor without reading anything. */
  resolve(uri: string): ResolvedResource | undefined;
  /** Drop cached bodies. Called after a mutation, because state moved. */
  invalidate(): void;
  stats(): ResourceServiceStats;
}

/**
 * Renders one task as a line. Shared by the backlog and project views so the two
 * cannot disagree about how a task reads.
 */
function taskLine(task: Task): string {
  const mark = task.status === "COMPLETED" ? "[done]" : `[${task.priority}]`;
  return `- ${mark} ${task.title}  (project: ${task.projectId}, owner: ${task.owner})`;
}

/** Renders the text views. Each returns a body, never a status code. */
function renderText(
  name: string,
  variables: Record<string, string>,
  tasks: TaskService,
): string {
  switch (name) {
    case "guidelines":
      return GUIDELINES;

    case "backlog": {
      const open = tasks.open();

      if (open.length === 0) {
        return "No open tasks.";
      }

      return [`Open tasks: ${open.length}`, "", ...open.map(taskLine)].join("\n");
    }

    case "summary": {
      const stats = tasks.stats();

      return [
        `Total tasks: ${stats.total}`,
        `Open tasks: ${stats.pending}`,
        `Completed: ${stats.completed}`,
        `High priority and open: ${stats.highPriority}`,
        `Projects involved: ${stats.projects.join(", ") || "none"}`,
      ].join("\n");
    }

    case "project": {
      const project = parseVariable(projectIdSchema, variables.projectId, "projectId");
      const inProject = tasks.inProject(project);

      if (inProject.length === 0) {
        // An empty *result*, not an error: the project is a valid address, it
        // simply holds nothing. Returning prose keeps the distinction honest.
        return `Project "${project}" has no tasks.`;
      }

      return [
        `Project: ${project}`,
        `Tasks: ${inProject.length}`,
        "",
        ...inProject.map(taskLine),
      ].join("\n");
    }

    default:
      throw new ResourceError(
        "NOT_FOUND",
        `No renderer for resource "${name}".`,
        "This is a server-side wiring bug: a descriptor was registered without a renderer.",
        { httpStatus: 500 },
      );
  }
}

/**
 * The renderer inventory.
 *
 * Declared as data so the constructor can prove, at boot, that it covers the
 * catalogue exactly. A descriptor with no renderer is a wiring bug that would
 * otherwise surface on the first `resources/read` of that URI — in production,
 * at 3 a.m., as a 500. Here it is a stack trace before the server ever accepts
 * a connection.
 */
const TEXT_RENDERERS = ["guidelines", "backlog", "summary", "project"] as const;
const JSON_RENDERERS = ["task", "user-profile"] as const;

/**
 * Parses a template variable, or refuses the read.
 *
 * Notes Ch04 §"Validate and constrain dynamic URIs": a template whose parameter
 * is unchecked is an enumeration oracle. A `{taskId}` of `"abc"` must therefore
 * be an `INVALID_INPUT` naming the variable — never a lookup that quietly
 * returns nothing, and never a document that pretends to be empty.
 */
function parseVariable<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");

    throw new ResourceError(
      "INVALID_INPUT",
      `Invalid ${name} in the resource URI — ${detail}.`,
      `Supply a ${name} that satisfies the template, or list the catalogue with resources/list.`,
    );
  }

  return parsed.data;
}

/**
 * Renders the JSON views.
 *
 * Notes Ch03 §3.8 — the MIME type is a contract. These two descriptors declare
 * `application/json`, so what comes back must parse, which is also why they are
 * not routed through the text renderer.
 */
function renderJson(
  name: string,
  variables: Record<string, string>,
  tasks: TaskService,
): string {
  switch (name) {
    case "task": {
      const raw = variables.taskId;
      const id = coercePositiveInt(raw);

      if (id === undefined) {
        throw new ResourceError(
          "INVALID_INPUT",
          `The task URI must carry a positive integer id, not "${raw ?? ""}".`,
          "List the catalogue with resources/list, or read task://tasks/{id} with a numeric id.",
        );
      }

      const task = tasks.find(id);

      if (task === undefined) {
        // Notes Ch03 §3.9 — a missing resource is a *protocol error*. Nothing
        // executed, so there is no `isError` channel to carry a recovery line.
        throw new ResourceError(
          "NOT_FOUND",
          `No task with id ${id}.`,
          "Call list_tasks, or read task://backlog, to see the ids that exist.",
        );
      }

      return JSON.stringify(task, null, 2);
    }

    case "user-profile": {
      const owner = parseVariable(userIdSchema, variables.userId, "userId");
      const owned = tasks.ownedBy(owner);

      if (owned.length === 0) {
        throw new ResourceError(
          "NOT_FOUND",
          `No profile found for user "${owner}".`,
          "Use a user id that owns at least one task, or read task://backlog to see the owners.",
        );
      }

      const open = owned.filter((task) => task.status === "PENDING");

      return JSON.stringify(
        {
          userId: owner,
          openTasks: open.length,
          totalTasks: owned.length,
          tasks: owned.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            projectId: task.projectId,
          })),
        },
        null,
        2,
      );
    }

    default:
      throw new ResourceError(
        "NOT_FOUND",
        `No JSON renderer for resource "${name}".`,
        "This is a server-side wiring bug: a descriptor was registered without a renderer.",
        { httpStatus: 500 },
      );
  }
}

export function createResourceService(options: {
  tasks: TaskService;
  catalogue: ResourceCatalogue;
  /** TTL for `cache: "ttl"` descriptors. `process` ignores it; `none` never caches. */
  ttlMs: number;
  /** Injectable clock, so a cache-expiry test does not have to sleep. */
  now?: () => number;
}): ResourceService {
  const { tasks, catalogue, ttlMs } = options;
  const now = options.now ?? (() => Date.now());

  const cache = new Map<string, { text: string; at: number }>();
  let hits = 0;
  let misses = 0;

  /**
   * The boot-time invariant. A descriptor without a renderer, or a renderer
   * without a descriptor, is a wiring bug — and the cheapest possible moment to
   * find it is now, before the process serves anything.
   */
  const renderable = new Set<string>([...TEXT_RENDERERS, ...JSON_RENDERERS]);
  const declared = new Set(catalogue.descriptors().map((descriptor) => descriptor.name));

  for (const name of declared) {
    if (!renderable.has(name)) {
      throw new Error(`[resources] descriptor "${name}" has no renderer. Add one to resourceService.ts.`);
    }
  }

  for (const name of renderable) {
    if (!declared.has(name)) {
      throw new Error(`[resources] renderer "${name}" has no descriptor. Add one to resourceCatalogue.ts.`);
    }
  }

  const isFresh = (at: number, policy: ResourceDescriptor["cache"]): boolean =>
    policy === "process" || now() - at < ttlMs;

  const render = (descriptor: ResourceDescriptor, variables: Record<string, string>): string =>
    descriptor.mimeType === MIME.json
      ? renderJson(descriptor.name, variables, tasks)
      : renderText(descriptor.name, variables, tasks);

  return {
    read(uri) {
      const resolved = catalogue.resolve(uri);

      if (resolved === undefined) {
        // Failing loudly beats returning an empty body: an empty string is
        // indistinguishable from "this policy says nothing", and the model will
        // answer confidently from it (Notes Ch03 §3.9).
        throw new ResourceError(
          "NOT_FOUND",
          `Unknown resource: ${uri}.`,
          "List the catalogue with resources/list and read one of the advertised URIs.",
        );
      }

      const { descriptor, variables } = resolved;
      const cacheable = descriptor.cache !== "none";
      const cached = cacheable ? cache.get(uri) : undefined;

      if (cached !== undefined && isFresh(cached.at, descriptor.cache)) {
        hits += 1;

        return {
          uri,
          descriptor,
          mimeType: descriptor.mimeType,
          text: cached.text,
          source: "cache",
          chars: cached.text.length,
        };
      }

      if (cacheable) {
        misses += 1;
      }

      const text = render(descriptor, variables);

      if (cacheable) {
        cache.set(uri, { text, at: now() });
      }

      return {
        uri,
        descriptor,
        mimeType: descriptor.mimeType,
        text,
        // "static" and "live" are different stories in a log line: one says the
        // body is a constant, the other says it was computed from state that
        // moved a moment ago.
        source: descriptor.kind === "static" ? "static" : "live",
        chars: text.length,
      };
    },

    list: () => catalogue.listable(),

    templates: () => catalogue.templates(),

    searchable: () => catalogue.searchable(),

    resolve: (uri) => catalogue.resolve(uri),

    invalidate() {
      cache.clear();
    },

    stats: () => ({ cached: cache.size, hits, misses }),
  };
}

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { MIME } from "../config/constants.js";
import { ResourceError, toAppError } from "../core/errors.js";
import { withTimeout } from "../core/guards.js";
import type { ResourceDescriptor } from "../domain/resourceCatalogue.js";
import type { ServerDeps } from "./deps.js";
import { toProtocolError } from "./protocol.js";

/**
 * Notes Ch03 and Ch04 — **The Resources Primitive**, where the **application**
 * holds the trigger.
 *
 * A Resource is *know*, not *do*: the application — never the model — decides to
 * read it, the content is read-only, and **the URI is the identity**. Reading a
 * resource executes nothing, which is exactly why a resource is the right shape
 * for a policy document and the wrong shape for an operation.
 *
 * The registrations below are **declarative**: the loop walks the descriptor
 * table and registers whatever it finds, rather than a human writing out six
 * near-identical blocks. That is the production form of Chapter 04's claim that
 * registration is declarative and automatic — and it is why adding a Resource
 * means editing one table, not two files.
 *
 * All three shapes from Chapter 04 are here, and the difference between them is
 * the lesson:
 *
 *   STATIC     one address, fixed content
 *   DYNAMIC    one address, content recomputed from live state
 *   TEMPLATE   a *family* of addresses — `task://projects/{projectId}` — whose
 *              instances are computed at `resources/list` time
 */

/**
 * The resource path's equivalent of a tool's `guard`.
 *
 * It exists because a resource failure is a **protocol error**, not a result
 * (Notes Ch03 §3.9): nothing executed, no model is waiting on a recovery
 * sentence, and there is no `isError` channel to carry one. So this wrapper's job
 * is the opposite of the tool guard's — it must make the failure *loud on the
 * wire* rather than friendly in the context.
 *
 * The scheme check happens **before** the read, and that ordering is the security
 * property: a URI outside the allowlist never reaches a renderer, so a template
 * cannot become an enumeration oracle over a scheme nobody meant to expose
 * (Notes Ch04 §"Validate and constrain dynamic URIs").
 */
async function readThrough(deps: ServerDeps, uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const scheme = uri.slice(0, uri.indexOf(":"));

  if (!deps.allowedSchemes.has(scheme)) {
    deps.metrics.count("resource.refused.scheme");
    deps.logger.warn("resource.refused", { uri, reason: "scheme not allow-listed", scheme });

    throw toProtocolError(
      new ResourceError(
        "FORBIDDEN",
        `Resource scheme "${scheme}" is not served here.`,
        `Use one of the allow-listed schemes: ${[...deps.allowedSchemes].join(", ")}.`,
      ),
    );
  }

  try {
    const read = await withTimeout(() => deps.resources.read(uri), deps.resourceTimeoutMs, uri, "resource");

    deps.metrics.count("resource.ok");
    deps.metrics.count(`resource.read.${read.descriptor.name}`);
    deps.metrics.count(`resource.source.${read.source}`);
    deps.metrics.observe("resource.chars", read.chars);
    deps.logger.info("resource.read", {
      uri,
      name: read.descriptor.name,
      kind: read.descriptor.kind,
      source: read.source,
      chars: read.chars,
    });

    return { contents: [{ uri: read.uri, mimeType: read.mimeType, text: read.text }] };
  } catch (error) {
    const failure = toAppError("resource", error, uri);

    deps.metrics.count("resource.error");
    deps.metrics.count(`resource.error.${failure.code}`);
    deps.logger.warn("resource.failure", { uri, code: failure.code, message: failure.message });

    /**
     * The failure keeps its **class** on the way out, and that is what makes the
     * answer useful.
     *
     * A missing resource becomes JSON-RPC `ResourceNotFound` (-32002) — the same
     * code the SDK's own `ResourceNotFoundError` produces, which is why this
     * module does not special-case it. A malformed template variable becomes
     * `InvalidParams` (-32602). Both reach the host as a *protocol error*, which
     * is the correct shape: nothing executed, so there is no `isError` channel
     * and no model waiting on a recovery sentence (Notes Ch03 §3.9).
     */
    throw toProtocolError(failure);
  }
}

/** The metadata every registration shares — four fields, written once. */
function metadataOf(descriptor: ResourceDescriptor) {
  return {
    title: descriptor.title,
    description: descriptor.description,
    mimeType: descriptor.mimeType,
  };
}

export function registerResources(server: McpServer, deps: ServerDeps): void {
  for (const descriptor of deps.catalogue.descriptors()) {
    if (descriptor.kind === "template") {
      registerTemplate(server, deps, descriptor);
    } else {
      registerFixed(server, deps, descriptor);
    }
  }
}

/**
 * STATIC and DYNAMIC share one registration, because the only difference between
 * them is whether the renderer reads live state — and that is
 * `resourceService`'s business, not the protocol layer's.
 *
 * The protocol layer's job is the three fields a client needs and nothing more:
 * where it lives, what it is called, and what the bytes are.
 */
function registerFixed(server: McpServer, deps: ServerDeps, descriptor: ResourceDescriptor): void {
  server.registerResource(
    descriptor.name,
    descriptor.uri,
    metadataOf(descriptor),
    // `resources/read` returns an *array* of contents. Text resources use `text`;
    // a PDF or an image would use a base64 `blob` instead.
    async (uri) => readThrough(deps, uri.href),
  );
}

/**
 * The two optional template hooks, typed explicitly.
 *
 * The annotations are not decoration: without them TypeScript widens each
 * `switch` branch into a union whose absent keys are typed `undefined`, which
 * cannot satisfy the SDK's index-signature contract. Naming the shape is both
 * the fix and the documentation.
 */
type ResourceEntry = { uri: string; name: string; title?: string; mimeType?: string };
type ListInstances = () => Promise<{ resources: ResourceEntry[] }>;
type Completions = Record<string, () => string[]>;

/**
 * `resources/list` for a template's instances.
 *
 * Computing them from live state rather than hardcoding them is the whole point:
 * the catalogue a client sees is derived from the same source the tools mutate,
 * so it cannot go stale.
 *
 * Note which template is **absent**. `user://{userId}/profile` deliberately has
 * no `list`, because enumerating every user's profile is an enumeration oracle —
 * the exact failure mode Chapter 04 warns about. A client may read a profile it
 * already has the id for; it may not ask for the set of all of them.
 */
function instancesFor(descriptor: ResourceDescriptor, deps: ServerDeps): ListInstances | undefined {
  switch (descriptor.name) {
    case "task":
      return async () => ({
        resources: deps.tasks.list().map((task) => ({
          uri: `task://tasks/${task.id}`,
          name: `task-${task.id}`,
          title: task.title,
          mimeType: MIME.json,
        })),
      });

    case "project":
      return async () => ({
        resources: deps.tasks.stats().projects.map((project) => ({
          uri: `task://projects/${project}`,
          name: `project-${project}`,
          title: `Project ${project}`,
          mimeType: MIME.text,
        })),
      });

    default:
      return undefined;
  }
}

/**
 * `completion/complete` for a template's variables, so a host can offer
 * suggestions while the user types a URI instead of making them guess.
 *
 * `user-profile` has no completions for the same reason it has no `list`: the
 * server has no session, so it cannot know whose id is being typed, and offering
 * the full set would be the oracle again by another route.
 */
function completionsFor(descriptor: ResourceDescriptor, deps: ServerDeps): Completions | undefined {
  switch (descriptor.name) {
    case "task":
      return { taskId: () => deps.tasks.list().map((task) => String(task.id)) };

    case "project":
      return { projectId: () => [...deps.tasks.stats().projects] };

    default:
      return undefined;
  }
}

function registerTemplate(server: McpServer, deps: ServerDeps, descriptor: ResourceDescriptor): void {
  const list = instancesFor(descriptor, deps);
  const complete = completionsFor(descriptor, deps);

  /**
   * A template is one definition serving a whole family of addresses. The
   * `{projectId}` is not a wildcard: the SDK matches whole path segments, so
   * `task://projects/fde` resolves and `task://projects/fde/extra` does not —
   * which is what keeps a template an address rather than a glob.
   */
  const template = new ResourceTemplate(descriptor.uri, {
    /**
     * `list` is always passed, even when it is `undefined` — the SDK's type
     * requires the key to be present.
     *
     * Passing `undefined` is the meaningful case: it is how a template says
     * *"these addresses exist, but I will not enumerate them for you"*. That is
     * exactly what `user://{userId}/profile` wants, and it is a stronger
     * statement than omitting the key.
     */
    list,
    ...(complete === undefined ? {} : { complete }),
  });

  server.registerResource(
    descriptor.name,
    template,
    metadataOf(descriptor),
    // A template callback receives the resolved URI. The variables have already
    // been extracted by the SDK; `resourceService` re-validates them, because a
    // template variable is user input and user input is never trusted twice.
    async (uri) => readThrough(deps, uri.href),
  );
}

import { ResourceNotFoundError, ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { URI_SCHEME } from "../config/env.js";
import type { ServerDeps } from "./deps.js";

/**
 * Chapter 06 §6.2–6.4 — Resources: addressable context.
 *
 * A Resource is *know*, not *do*: the application — never the model — decides to
 * read it, the content is read-only, and **the URI is the identity**. Reading a
 * resource executes nothing, which is exactly why a resource is the right shape
 * for a policy document and the wrong shape for an operation.
 *
 * Two shapes are registered below, and the difference between them is the
 * lesson:
 *
 *  · a **static resource** is one address with fixed content;
 *  · a **template** is a *family* of addresses — `company://tasks/{taskId}` —
 *    whose instances are computed at `resources/list` time. This is how you
 *    expose "any task" without pretending to enumerate every task in code, and
 *    it is why a template can never drift from live state.
 */

/** Fixed content, fixed addresses. Read-only by construction. */
const POLICIES: Record<string, string> = {
  "return-policy":
    "Returns are accepted within 30 days of delivery. Electronics must include the original packaging.",
  "refund-policy": "Refunds are issued to the original payment method within 5 business days of approval.",
};

export function registerResources(server: McpServer, deps: ServerDeps): void {
  for (const [name, text] of Object.entries(POLICIES)) {
    const uri = `${URI_SCHEME}://policies/${name}`;

    server.registerResource(
      name,
      uri,
      {
        title: name.replace(/-/g, " "),
        description: `Company policy exposed as addressable context at ${uri}`,
        mimeType: "text/plain",
      },
      // `resources/read` returns an array of contents. Text resources use
      // `text`; a PDF or an image would use a base64 `blob` instead.
      async (readUri) => ({
        contents: [{ uri: readUri.href, mimeType: "text/plain", text }],
      }),
    );
  }

  const taskTemplate = new ResourceTemplate(`${URI_SCHEME}://tasks/{taskId}`, {
    /**
     * `resources/list` for the template's instances.
     *
     * Computing them from live state rather than hardcoding them is the whole
     * point: the catalogue a client sees is derived from the same source the
     * tools mutate, so it cannot go stale.
     */
    list: async () => ({
      resources: deps.service.list().map((task) => ({
        uri: `${URI_SCHEME}://tasks/${task.id}`,
        name: `task-${task.id}`,
        title: task.title,
        mimeType: "application/json",
      })),
    }),

    /**
     * `completion/complete` for the `{taskId}` variable, so a host can offer
     * suggestions while the user types a URI instead of making them guess.
     */
    complete: {
      taskId: () => deps.service.list().map((task) => String(task.id)),
    },
  });

  server.registerResource(
    "task",
    taskTemplate,
    {
      title: "Task",
      description: "One task as addressable JSON, addressed by id",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.taskId;
      const id = Array.isArray(raw) ? raw[0] : raw;
      const task = deps.service.find(id);

      /**
       * A missing resource is a **protocol error**, not a tool result: there is
       * no `isError` mechanism on `resources/read`, because nothing executed and
       * no model is waiting on a recovery instruction. `ResourceNotFoundError`
       * says precisely that on the wire.
       */
      if (task === undefined) {
        throw new ResourceNotFoundError(uri.href);
      }

      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(task, null, 2) }],
      };
    },
  );
}

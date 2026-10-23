import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Logger } from "../core/logger.js";
import type { Metrics } from "../core/metrics.js";

/**
 * Notes Ch03 §3.1 and Ch07 §7.2 — the MCP **client**: one function per protocol
 * verb, so the difference between reading a Resource and fetching a Prompt is
 * visible on the page.
 *
 * This module is the host's only door to the server. Nothing above it imports the
 * SDK, which is what makes the rest of `src/host` and all of `src/controllers`
 * testable against a stub — and what keeps the answer to *"what does this
 * application actually do with the protocol?"* down to seven functions.
 *
 * Two details are here because the lecture names them and most clients get them
 * wrong:
 *
 *  · **Pagination.** `resources/list` and `prompts/list` are paged with
 *    `nextCursor`, and a client that ignores it silently sees only the first
 *    page. At demo scale that is invisible; at real scale it is a bug that looks
 *    like missing data (Notes Ch03 §3.9).
 *
 *  · **Two content shapes.** A tool result is `content[]` blocks carrying a
 *    `type` discriminator; resource contents are `{ uri, mimeType, text | blob }`.
 *    They are two different wire contracts, so they get two different extractors
 *    rather than one clever one.
 */

/**
 * The SDK's own return types, named rather than re-declared.
 *
 * Writing these out by hand would be a second copy of the protocol to keep in
 * sync; deriving them means a protocol change shows up as a type error here
 * instead of a runtime surprise in a controller.
 */
export type ListedResources = Awaited<ReturnType<Client["listResources"]>>["resources"];
export type ListedTemplates = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"];
export type ListedPrompts = Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
export type ListedTools = Awaited<ReturnType<Client["listTools"]>>["tools"];
export type RenderedPrompt = Awaited<ReturnType<Client["getPrompt"]>>;
export type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

/** One resource read, flattened to what the application actually uses. */
export interface ResourceBody {
  uri: string;
  mimeType: string;
  text: string;
  chars: number;
}

export interface McpClient {
  /** The escape hatch, for a caller that needs a verb this interface does not wrap. */
  readonly raw: Client;
  /** Every page, followed to exhaustion — never just the first one. */
  listResources(): Promise<{ resources: ListedResources; templates: ListedTemplates }>;
  read(uri: string): Promise<ResourceBody>;
  listPrompts(): Promise<ListedPrompts>;
  getPrompt(name: string, args: Record<string, string>): Promise<RenderedPrompt>;
  listTools(): Promise<ListedTools>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/**
 * A result is `content[]` blocks, never a bare value (Notes Ch03 §3.8).
 *
 * Only `text` blocks are joined: a client that stringifies an image block would
 * put base64 into a prompt, which is a token-budget incident rather than a bug
 * report.
 */
export function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;

  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Resource contents are `{ uri, mimeType, text | blob }` — a *different* shape
 * from a tool's content blocks, which carry a `type` discriminator. Two
 * extractors, because they are two different wire contracts.
 *
 * Both variants are named in the parameter type so the compiler can check that a
 * binary resource is handled rather than silently dropped.
 */
export function resourceText(contents: ReadonlyArray<{ text?: string; blob?: string }>): string {
  return contents
    .map((content) => content.text ?? (content.blob === undefined ? "" : "[binary content]"))
    .join("\n")
    .trim();
}

export async function createMcpClient(options: {
  url: string;
  logger: Logger;
  metrics: Metrics;
}): Promise<McpClient> {
  const { url, logger, metrics } = options;

  const client = new Client({ name: "task-host", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));

  await client.connect(transport);
  logger.info("client.connected", { url });

  /**
   * Follows `nextCursor` until the server stops offering one.
   *
   * Written once as a generic so the three list verbs cannot diverge — the
   * classic bug is a client that paginates `resources/list` and forgets to in
   * `prompts/list`, which only shows up on the day the catalogue grows past one
   * page.
   */
  const drain = async <Item>(
    verb: string,
    page: (cursor: string | undefined) => Promise<{ items: Item[]; nextCursor?: string }>,
  ): Promise<Item[]> => {
    const items: Item[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const result = await page(cursor);
      items.push(...result.items);
      cursor = result.nextCursor;
      pages += 1;

      // A server that returns the same cursor forever would otherwise hang the
      // host. Ten pages is far past any realistic catalogue and still finite.
      if (pages >= 10) {
        logger.warn("client.pagination_capped", { verb, pages, collected: items.length });
        break;
      }
    } while (cursor !== undefined);

    if (pages > 1) {
      logger.debug("client.paginated", { verb, pages, items: items.length });
    }

    return items;
  };

  return {
    raw: client,

    async listResources() {
      const resources = await drain<ListedResources[number]>("resources/list", async (cursor) => {
        const page = await metrics.time("client.listResources", () =>
          client.listResources(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.resources, nextCursor: page.nextCursor };
      });

      const templates = await drain<ListedTemplates[number]>("resources/templates/list", async (cursor) => {
        const page = await metrics.time("client.listResourceTemplates", () =>
          client.listResourceTemplates(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.resourceTemplates, nextCursor: page.nextCursor };
      });

      return { resources, templates };
    },

    async read(uri) {
      const result = await metrics.time("client.readResource", () => client.readResource({ uri }));
      const text = resourceText(result.contents);
      const first = result.contents[0];

      return {
        uri,
        // The declared type, taken from the reply rather than assumed — a host
        // that guesses the MIME type will eventually render JSON as prose.
        mimeType: first?.mimeType ?? "text/plain",
        text,
        chars: text.length,
      };
    },

    async listPrompts() {
      return drain<ListedPrompts[number]>("prompts/list", async (cursor) => {
        const page = await metrics.time("client.listPrompts", () =>
          client.listPrompts(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.prompts, nextCursor: page.nextCursor };
      });
    },

    /**
     * Notes Ch07 §7.3 — this talks to the **MCP server** and returns *messages*.
     *
     * It is not a model call, it does not need an API key, and it is the reason
     * the prompt path is testable offline. The model call happens afterwards, in
     * `host/model.ts`, and keeping them in two files is what makes that
     * impossible to conflate by accident.
     */
    getPrompt: (name, args) =>
      metrics.time("client.getPrompt", () => client.getPrompt({ name, arguments: args })),

    async listTools() {
      return drain<ListedTools[number]>("tools/list", async (cursor) => {
        const page = await metrics.time("client.listTools", () =>
          client.listTools(cursor === undefined ? {} : { cursor }),
        );

        return { items: page.tools, nextCursor: page.nextCursor };
      });
    },

    callTool: (name, args) =>
      metrics.time("client.callTool", () => client.callTool({ name, arguments: args })),

    async close() {
      try {
        await transport.terminateSession();
      } catch {
        // No session was established, so there is nothing to terminate.
      }

      await client.close();
      logger.info("client.closed", { url });
    },
  };
}

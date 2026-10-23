import type { McpServer } from "@modelcontextprotocol/server";
import { policyScheme } from "../config/config.js";

/**
 * Chapter 06 §6.2–6.4 — Resources: addressable context.
 *
 * A Resource is *know*, not *do*: the application (never the model) decides to
 * read it, the content is read-only, and the URI is what makes it addressable.
 * Reading a resource executes nothing.
 */
const policies: Record<string, string> = {
  "return-policy": "Returns are accepted within 30 days of delivery. Electronics must include the original packaging.",
  "refund-policy": "Refunds are issued to the original payment method within 5 business days of approval.",
};

export function registerResources(server: McpServer): void {
  for (const [name, text] of Object.entries(policies)) {
    const uri = `${policyScheme}://policies/${name}`;

    server.registerResource(
      name,
      uri,
      {
        title: name.replace(/-/g, " "),
        description: `Company policy exposed as addressable context at ${uri}`,
        mimeType: "text/plain",
      },
      // `resources/read` — the client retrieves the content by URI. Text
      // resources use `text`; binary ones would use a base64 `blob`.
      async (readUri) => ({
        contents: [{ uri: readUri.href, mimeType: "text/plain", text }],
      }),
    );
  }
}

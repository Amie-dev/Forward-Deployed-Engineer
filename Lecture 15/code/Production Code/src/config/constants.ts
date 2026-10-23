/**
 * Notes Ch03 §3.5 and Ch04 §4.2 — the shared vocabulary of the resource layer.
 *
 * Three things live here rather than in the files that use them, because more
 * than one layer has to agree on them:
 *
 *  · the **URI schemes** — the server resolves them, a client never fetches them;
 *  · the **MIME types** — a contract about how a host may render the bytes;
 *  · the **truncation marker** — the sentence a truncated read appends, so the
 *    model is told content was cut rather than silently misled (Notes Ch02).
 */

/**
 * Notes Ch03 §3.5 — *the URI is an identifier, not a URL.*
 *
 * `https://` would only be honest if the client could fetch the URI itself; it
 * cannot. A private scheme keeps the address truthful, and it gives the host a
 * cheap, unambiguous check to run before it dereferences anything.
 */
export const URI_SCHEME = {
  /** Task-domain resources: `task://guidelines`, `task://backlog`, `task://projects/{projectId}`. */
  task: "task",
  /** User-domain resources: `user://{userId}/profile`. */
  user: "user",
} as const;

export type UriScheme = (typeof URI_SCHEME)[keyof typeof URI_SCHEME];

/**
 * Notes Ch03 §3.8 — *MIME type is a contract.*
 *
 * Lying about it corrupts the host's rendering, so the two values are named once
 * and reused by both the catalogue and every `resources/read` reply.
 */
export const MIME = {
  /** Prose: guidelines, backlogs, briefs. What a host renders as text. */
  text: "text/plain",
  /** Typed payloads a client can parse: profiles, per-task documents. */
  json: "application/json",
} as const;

export type MimeType = (typeof MIME)[keyof typeof MIME];

/**
 * Notes Ch02 §"Size and token budget" — *truncate deliberately and TELL the
 * model it was truncated.*
 *
 * A silent cut is worse than a refusal: the model answers confidently from half
 * a document and the user has no way to know. This marker is appended by
 * `ContextBudget` and is the reason a truncated read is still an honest read.
 */
export function truncationMarker(shown: number, total: number): string {
  return `\n\n[truncated: showing the first ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters]`;
}

/**
 * The separator between two resource blocks inside an assembled prompt.
 *
 * Delimiting is not cosmetic (Notes Ch04 §"Do not let Resources become a
 * prompt-injection channel"): resource content is untrusted text that gains
 * system-level authority the moment it lands in a prompt, so each block is
 * fenced with its URI and the fences are machine-generated, never content.
 */
export function contextFence(uri: string, strategy: string): string {
  return `--- ${uri} (chosen by ${strategy}) ---`;
}

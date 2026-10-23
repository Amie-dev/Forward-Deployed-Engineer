import { MIME, URI_SCHEME, type MimeType } from "../config/constants.js";

/**
 * Notes Ch03 §3.6 and Ch04 §4.1 — the **catalogue**: every Resource this server
 * can serve, described once, in one place.
 *
 * This file exists because of the question Chapter 04 asks:
 *
 *   *"How do I expose ten thousand resources without writing ten thousand
 *   definitions?"*
 *
 * The answer is that a Resource has two halves with very different lifetimes.
 * The **descriptor** — URI shape, name, description, MIME type, who may read it,
 * how it may be cached — is written by hand and changes when the API changes.
 * The **instances** are computed from live state and change constantly. Keeping
 * the descriptor table separate from the handlers is what lets the same six
 * descriptors serve a handful of tasks today and a hundred thousand tomorrow,
 * and it is what lets three other layers reason about Resources *without
 * reading any content*:
 *
 *  · `services/selectionService.ts` ranks descriptors (Notes Ch05 §"Retrieval");
 *  · `host/policy.ts` decides what may be read, before a handler runs
 *    (Notes Ch04 §"Authorisation and validation live in the handler");
 *  · `host/audit.ts` names what was chosen without storing what it said.
 */

/**
 * The three shapes from Notes Ch04 §4.4–4.7. The difference is not cosmetic —
 * it is a caching and failure-mode decision as much as a code-shape one.
 */
export type ResourceKind =
  /** One address, one constant body. Cacheable for the process lifetime. */
  | "static"
  /** One address, a body recomputed on every read. Never stale, never cacheable for long. */
  | "dynamic"
  /** One definition serving a whole *family* of addresses. */
  | "template";

/** Notes Ch04 §"Cache like a read-heavy system". */
export type CachePolicy =
  /** Content cannot change: cache for the life of the process. */
  | "process"
  /** Content tracks live state: cache for the configured TTL. */
  | "ttl"
  /** Content is per-instance and cheap: do not cache at all. */
  | "none";

/**
 * Notes Ch04 §"Do not put privileged data behind a URI the host can read
 * freely." Reading is application-controlled — but the application is code, and
 * code has bugs, so the intended audience is declared rather than assumed.
 */
export type ResourceAudience =
  /** Company-wide reference material: anyone may read it. */
  | "public"
  /** Personal data: only the owner of the URI's variable may read it. */
  | "owner";

export interface ResourceDescriptor {
  /** Stable identity, used as a metric label and a log field. */
  name: string;
  kind: ResourceKind;
  /** A fixed URI, or — when `kind` is `template` — a URI template. */
  uri: string;
  title: string;
  /**
   * Notes Ch03 §3.6 — **the description is retrieval text.** It is what a
   * ranker scores and what a user scans, so it is written for a chooser, not
   * for someone who already knows the file exists.
   */
  description: string;
  mimeType: MimeType;
  /** The words that make this Resource match a query (Notes Ch05 §"Retrieval"). */
  keywords: readonly string[];
  audience: ResourceAudience;
  cache: CachePolicy;
}


/**
 * The descriptor table. Six Resources — one static, two dynamic, three
 * templated — which between them cover every case the lecture names:
 *
 *   task://guidelines             static    the guidelines case (Ch02 §2.1)
 *   task://backlog                dynamic   live state, recomputed per read (Ch04 §4.5)
 *   task://summary                dynamic   an aggregate view (Ch04 §4.5)
 *   task://projects/{projectId}   template  "every task in one project" (Ch04 §4.6)
 *   task://tasks/{taskId}         template  one addressable document per task
 *   user://{userId}/profile       template  the lecture's own example (Ch04 §4.7)
 */
export const RESOURCE_DESCRIPTORS: readonly ResourceDescriptor[] = [
  {
    name: "guidelines",
    kind: "static",
    uri: `${URI_SCHEME.task}://guidelines`,
    title: "Task management guidelines",
    description:
      "Company rules for prioritising and scheduling tasks: when to do deep work, when to hold meetings, how many high-priority tasks a day may hold. Read this before planning anyone's day.",
    mimeType: MIME.text,
    keywords: ["guideline", "policy", "rule", "priorit", "schedule", "deep work", "should i"],
    audience: "public",
    cache: "process",
  },
  {
    name: "backlog",
    kind: "dynamic",
    uri: `${URI_SCHEME.task}://backlog`,
    title: "Open backlog",
    description:
      "Every task that is not done yet, with its priority, project and owner. Use this when the user asks what is on their plate or what they still owe.",
    mimeType: MIME.text,
    keywords: ["task", "backlog", "to-do", "todo", "pending", "plate", "open", "outstanding"],
    audience: "public",
    cache: "ttl",
  },
  {
    name: "summary",
    kind: "dynamic",
    uri: `${URI_SCHEME.task}://summary`,
    title: "Workload summary",
    description:
      "Counts of open tasks by priority, plus the projects they belong to and how many are completed. Use this to answer questions like 'how busy am I?' or 'is this realistic?'.",
    mimeType: MIME.text,
    keywords: ["how many", "how busy", "summary", "overview", "workload", "realistic", "capacity"],
    audience: "public",
    cache: "ttl",
  },
  {
    name: "project",
    kind: "template",
    uri: `${URI_SCHEME.task}://projects/{projectId}`,
    title: "Project brief",
    description:
      "Every task in one project, open and completed, addressed by project id. Replace {projectId} with a project such as fde or media.",
    mimeType: MIME.text,
    keywords: ["project", "brief", "epic", "fde", "media"],
    audience: "public",
    cache: "ttl",
  },
  {
    name: "task",
    kind: "template",
    uri: `${URI_SCHEME.task}://tasks/{taskId}`,
    title: "Task document",
    description:
      "One task as addressable JSON, addressed by numeric id. This is how a family of ten thousand documents is exposed by one definition.",
    mimeType: MIME.json,
    keywords: ["task detail", "one task", "task id"],
    audience: "public",
    cache: "none",
  },
  {
    name: "user-profile",
    kind: "template",
    uri: `${URI_SCHEME.user}://{userId}/profile`,
    title: "User profile",
    description:
      "One person's profile and open workload, addressed by user id. Personal data: only the owner of the id may read it.",
    mimeType: MIME.json,
    keywords: ["profile", "user", "person", "me", "whoami"],
    audience: "owner",
    cache: "ttl",
  },
];

/** A catalogue entry as `resources/list` reports it — metadata only, never content. */
export interface CatalogueEntry {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  kind: ResourceKind;
}

/** A descriptor plus the template variables a concrete URI resolved to. */
export interface ResolvedResource {
  descriptor: ResourceDescriptor;
  variables: Record<string, string>;
}

/**
 * The ranker's input.
 *
 * `haystack` is pre-computed once, at construction, because the selection path
 * runs on every request and re-joining a description on each one is exactly the
 * kind of per-request allocation that turns a cheap ranker into a hot spot.
 *
 * Note what is *not* here: content. Notes Ch05 §"Retrieval" is explicit that
 * retrieval embeds **Resource metadata**, not the whole corpus — which is why
 * ranking is possible before anything is read.
 */
export interface SearchableEntry {
  descriptor: ResourceDescriptor;
  haystack: string;
}

export interface ResourceCatalogue {
  descriptors(): readonly ResourceDescriptor[];
  byName(name: string): ResourceDescriptor | undefined;
  /** The non-template entries — what `resources/list` advertises as instances. */
  listable(): CatalogueEntry[];
  /** The template entries — what `resources/templates/list` advertises. */
  templates(): readonly ResourceDescriptor[];
  searchable(): readonly SearchableEntry[];
  /** Match a concrete URI back to a descriptor, extracting template variables. */
  resolve(uri: string): ResolvedResource | undefined;
  /** The scheme of a URI, lower-cased — the first check the policy runs. */
  schemeOf(uri: string): string | undefined;
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const VARIABLE_SEGMENT = /^\{([A-Za-z0-9_]+)\}$/;

/**
 * Compiles a URI template into a matcher, once.
 *
 * Segment-by-segment rather than a naive `replace`, because the grammar matters:
 * a `{var}` occupies a **whole segment**, so `task://projects/{projectId}` must
 * not match `task://projects/fde/extra`. A glob would, and a glob is how a
 * template quietly becomes an enumeration oracle over a path space nobody
 * intended to expose (Notes Ch04 §"Validate and constrain dynamic URIs").
 */
function compileTemplate(template: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];

  const pattern = template
    .split("/")
    .map((segment) => {
      const variable = VARIABLE_SEGMENT.exec(segment);

      if (variable === null) {
        // Escape every regex metacharacter in a literal segment.
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      const name = variable[1];

      if (name === undefined) {
        return segment;
      }

      names.push(name);
      return "([^/]+)";
    })
    .join("/");

  return { pattern: new RegExp(`^${pattern}$`), names };
}

export function createResourceCatalogue(
  descriptors: readonly ResourceDescriptor[] = RESOURCE_DESCRIPTORS,
): ResourceCatalogue {
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

  // Compile every template once, at construction. The alternative — compiling on
  // each `resolve` — puts a `new RegExp` on the hot path of every policy check.
  const compiled = new Map<string, { pattern: RegExp; names: string[] }>(
    descriptors
      .filter((descriptor) => descriptor.kind === "template")
      .map((descriptor) => [descriptor.uri, compileTemplate(descriptor.uri)]),
  );

  const toEntry = (descriptor: ResourceDescriptor): CatalogueEntry => ({
    uri: descriptor.uri,
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    mimeType: descriptor.mimeType,
    kind: descriptor.kind,
  });

  return {
    descriptors: () => descriptors,

    byName: (name) => byName.get(name),

    listable: () =>
      descriptors.filter((descriptor) => descriptor.kind !== "template").map(toEntry),

    templates: () => descriptors.filter((descriptor) => descriptor.kind === "template"),

    searchable: () =>
      descriptors.map((descriptor) => ({
        descriptor,
        haystack: [descriptor.title, descriptor.description, ...descriptor.keywords]
          .join(" ")
          .toLowerCase(),
      })),

    resolve(uri) {
      for (const descriptor of descriptors) {
        if (descriptor.kind !== "template") {
          if (descriptor.uri === uri) {
            return { descriptor, variables: {} };
          }
          continue;
        }

        const matcher = compiled.get(descriptor.uri);

        if (matcher === undefined) {
          continue;
        }

        const match = matcher.pattern.exec(uri);

        if (match === null) {
          continue;
        }

        const variables: Record<string, string> = {};

        matcher.names.forEach((name, index) => {
          const value = match[index + 1];

          if (value !== undefined) {
            // Decode, because a URI segment may be percent-encoded and a
            // variable that arrives as `%20` would otherwise be a different
            // resource from the one the caller meant.
            variables[name] = decodeURIComponent(value);
          }
        });

        return { descriptor, variables };
      }

      return undefined;
    },

    schemeOf(uri) {
      const match = SCHEME.exec(uri);
      return match?.[1]?.toLowerCase();
    },
  };
}


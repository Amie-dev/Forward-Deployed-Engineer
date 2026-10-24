# Chapter 08 — Domain: The Resource Catalogue

> **The file that answers Chapter 04's question:** *"How do I expose ten thousand resources without
> writing ten thousand definitions?"* A Resource has two halves with very different lifetimes — the
> **descriptor**, written by hand, and the **instances**, computed from live state — and separating
> them is what lets six descriptors serve a handful of tasks today and a hundred thousand tomorrow.

---

## File details

| | |
| :--- | :--- |
| **File** | `src/domain/resourceCatalogue.ts` (337 lines) |
| **Layer** | `domain` — imports only `config/constants.js`. No protocol, no handlers, no content. |
| **Purpose** | Describe every Resource once: URI shape, name, description, MIME type, audience, cache policy. Provide the lookup, listing, template matching and search metadata that three other layers consume. |
| **Exports** | `ResourceKind`, `CachePolicy`, `ResourceAudience`, `ResourceDescriptor`, `RESOURCE_DESCRIPTORS`, `CatalogueEntry`, `ResolvedResource`, `SearchableEntry`, `ResourceCatalogue`, `createResourceCatalogue()` |
| **Lecture sections** | Ch03 §3.6 (descriptions are retrieval text), Ch04 §4.1/4.4–4.7 (the three shapes), Ch04 §"Validate and constrain dynamic URIs", Ch05 §"Retrieval" |
| **Runs** | `npm run lifecycle` steps 4 and 5 · `GET /resources` on the host |

---

## Commands

```bash
# what the catalogue advertises — metadata only
npm run lifecycle 2>/dev/null | sed -n '/^4\./,/^5\./p'

# the same catalogue over HTTP
curl -s http://127.0.0.1:8080/resources
```

---

## Descriptors versus instances

The header opens with the distinction the whole file rests on:

> The **descriptor** — URI shape, name, description, MIME type, who may read it, how it may be cached —
> is written by hand and changes when the API changes. The **instances** are computed from live state
> and change constantly.

Read those two sentences as a table, because they have different owners, different change rates and
different homes in this codebase:

| | Descriptor | Instances |
| :--- | :--- | :--- |
| **Written by** | Hand, in this file | Code, from live state |
| **Changes when** | The API changes | Anything changes |
| **Lives in** | `domain/resourceCatalogue.ts` | `services/resourceService.ts` renderers |
| **Example** | `task://projects/{projectId}` — *a project brief exists* | `task://projects/fde` — *these three tasks are in fde* |
| **Count** | 6 | Unbounded |

Keeping them apart buys something specific, and the header names the three consumers:

> · `services/selectionService.ts` ranks descriptors (Notes Ch05 §"Retrieval");
> · `host/policy.ts` decides what may be read, before a handler runs (Notes Ch04 §"Authorisation and
>   validation live in the handler");
> · `host/audit.ts` names what was chosen without storing what it said.

**Three layers reason about Resources without reading any content.** That is the property worth
noticing. The ranker scores descriptions and keywords; the ACL compares an audience declaration
against a session; the audit log records a URI. None of them calls a renderer, none of them touches
task state, and none of them needs a round trip to the server.

It is also why `list_tasks` (a Tool) and `task://backlog` (a Resource) can be *byte-identical* while
still being different primitives: the catalogue is what knows a Resource exists, and the renderer is
what produces its body. The catalogue never sees the body.

---

## `src/domain/resourceCatalogue.ts` — the full file

```ts
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
```

### Block-by-block

**Block 1 — the three unions (lines 27–56).**

```ts
export type ResourceKind = "static" | "dynamic" | "template";
export type CachePolicy = "process" | "ttl" | "none";
export type ResourceAudience = "public" | "owner";
```

Three small unions, each naming a decision that would otherwise be scattered through the codebase.

**`ResourceKind` — the three shapes from Ch04 §4.4–4.7.** The comment on the type insists the
difference is not cosmetic: *it is a caching and failure-mode decision as much as a code-shape one.*

| Kind | Its doc comment | The consequence |
| :--- | :--- | :--- |
| `static` | One address, one constant body | Cacheable for the process lifetime |
| `dynamic` | One address, a body recomputed on every read | Never stale, never cacheable for long |
| `template` | One definition serving a whole *family* of addresses | Bounded by the template's grammar, not by a list |

The `dynamic` comment contains a trade in six words — *never stale, never cacheable for long* — which
is the honest statement of what a live body costs. A dynamic Resource is always correct and always
costs a render; a static one is free and can only be correct if its content really is constant.

**`CachePolicy` — deliberately separate from `ResourceKind`.** Three values (`process`, `ttl`,
`none`) against the kind's three, so it is tempting to derive one from the other. The reason not to is
that the mapping is a *policy choice*, not a fact about the shape: a template could be cached per
instance if its renderer were expensive, and a static Resource with a `ttl` policy would be a bug. As
separate fields, the choice is explicit and reviewable in the descriptor table.

**`ResourceAudience` — the security declaration.** Its comment is the argument:

> Notes Ch04 §"Do not put privileged data behind a URI the host can read freely." Reading is
> application-controlled — but **the application is code, and code has bugs**, so the intended audience
> is declared rather than assumed.

That is a sharp point. "Reading is application-controlled" sounds like a safety property, and it is
not one: it means *no model can read this without the application deciding to*, which says nothing
about whether the application decides correctly. A declaration in the descriptor is checkable —
`host/policy.ts` compares `audience` against the session, and a Resource marked `owner` cannot be
served to a non-owner even if a handler has a bug, because the check happens before the handler runs.

Two values only: `public` (*company-wide reference material*) and `owner` (*only the owner of the
URI's variable*). That is enough for every Resource here, and adding a third would need a consumer.

**Block 2 — `ResourceDescriptor` (lines 58–81).**

```ts
export interface ResourceDescriptor {
  name: string;
  kind: ResourceKind;
  uri: string;
  title: string;
  description: string;
  mimeType: MimeType;
  keywords: readonly string[];
  audience: ResourceAudience;
  cache: CachePolicy;
}
```

Nine fields, and three of them carry comments that are really design rules:

**`uri` is polymorphic.** *A fixed URI, or — when `kind` is `template` — a URI template.* One field for
both, discriminated by `kind`. That is why `resolve()` below has to branch on `kind`: the same string
is either an exact address or a pattern, and only the kind says which.

**`description` is retrieval text, not documentation.** This is the field most likely to be written
badly, so the comment is blunt:

> Notes Ch03 §3.6 — **the description is retrieval text.** It is what a ranker scores and what a user
> scans, so it is written for a chooser, not for someone who already knows the file exists.

That reframing changes how you write it. "Company rules for prioritising and scheduling tasks" is
documentation — it tells you what the file is. Compare the actual value in the table below:

```text
"Company rules for prioritising and scheduling tasks: when to do deep work, when to hold
 meetings, how many high-priority tasks a day may hold. Read this before planning anyone's day."
```

Three concrete topics (*deep work*, *meetings*, *high-priority tasks*) and one instruction (*read this
before planning anyone's day*). The topics are what a ranker matches against; the instruction is what
a chooser needs. A description written for someone who already knows the Resource exists would say
"the guidelines document" and match nothing.

**`keywords` exist because descriptions are not enough.** *The words that make this Resource match a
query (Notes Ch05 §"Retrieval").* Look at the guidelines' keywords:

```ts
keywords: ["guideline", "policy", "rule", "priorit", "schedule", "deep work", "should i"],
```

`"priorit"` is a **stem**, not a word — it matches *priority*, *prioritise*, *prioritising* and
*priorities* with one entry. `"should i"` is a **phrase**, and it is there because the lecture's own
example query is *"what should I do in project media"*. These are not synonyms of the description;
they are the literal strings users type. A keyword list is a lookup table from user language to
Resource, and it is the cheapest retrieval improvement available.

The `readonly string[]` type matters: a caller that pushed into `keywords` would be mutating the
shared catalogue, and `readonly` makes that a compile error.

**Block 3 — the six descriptors (lines 83–160).**

The table's doc comment gives the mapping to the notes, and it is worth reading as a syllabus:

```text
task://guidelines             static    the guidelines case (Ch02 §2.1)
task://backlog                dynamic   live state, recomputed per read (Ch04 §4.5)
task://summary                dynamic   an aggregate view (Ch04 §4.5)
task://projects/{projectId}   template  "every task in one project" (Ch04 §4.6)
task://tasks/{taskId}         template  one addressable document per task
user://{userId}/profile       template  the lecture's own example (Ch04 §4.7)
```

Six descriptors covering every case the lecture names. The full table:

| name | kind | uri | mime | audience | cache |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `guidelines` | static | `task://guidelines` | `text/plain` | public | process |
| `backlog` | dynamic | `task://backlog` | `text/plain` | public | ttl |
| `summary` | dynamic | `task://summary` | `text/plain` | public | ttl |
| `project` | template | `task://projects/{projectId}` | `text/plain` | public | ttl |
| `task` | template | `task://tasks/{taskId}` | `application/json` | public | none |
| `user-profile` | template | `user://{userId}/profile` | `application/json` | **owner** | ttl |

Three things to read out of that table:

**Only one descriptor is `owner`.** `user-profile` — *"Personal data: only the owner of the id may read
it."* Everything else is company-wide reference material. That single value is what the ACL in
Chapter 20 acts on, and it is why the lifecycle's step 7 can show the same URI being refused for one
session and allowed for another.

**The two `application/json` Resources are the two with structured payloads.** `task://tasks/{taskId}`
is one task as JSON; `user://{userId}/profile` is a profile as JSON. The other four are prose for a
model to read. MIME type is a contract (Ch03 §3.8), and these two are the ones a client could parse.

**`task://tasks/{taskId}` is cached `none`.** It is the only one, and it is deliberate: a per-task
document is cheap to render and addressed by an id that changes constantly. Caching it would add a
`Map` entry per task read for no benefit — and the descriptor says so, in the one field a reader would
check.

**Block 4 — the three derived interfaces (lines 162–200).**

```ts
export interface CatalogueEntry {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  kind: ResourceKind;
}
```

*A catalogue entry as `resources/list` reports it — metadata only, never content.* Note `mimeType` is
typed `string` here while `ResourceDescriptor.mimeType` is `MimeType`. That is the wire boundary
showing through: internally the MIME type is one of two known literals, but what goes on the wire is
a string, and typing it as the union would be a claim about data the client controls.

```ts
export interface ResolvedResource {
  descriptor: ResourceDescriptor;
  variables: Record<string, string>;
}
```

*A descriptor plus the template variables a concrete URI resolved to.* This is what `resolve()`
returns, and `variables` is the payoff of the template system: `task://projects/fde` resolves to the
`project` descriptor plus `{ projectId: "fde" }`, and the renderer needs nothing else to produce the
body.

```ts
export interface SearchableEntry {
  descriptor: ResourceDescriptor;
  haystack: string;
}
```

The ranker's input, and its comment contains two decisions:

> `haystack` is pre-computed once, at construction, because the selection path runs on every request
> and re-joining a description on each one is exactly the kind of per-request allocation that turns a
> cheap ranker into a hot spot.

> Note what is *not* here: **content**. Notes Ch05 §"Retrieval" is explicit that retrieval embeds
> **Resource metadata**, not the whole corpus — which is why ranking is possible before anything is
> read.

The second point is the architectural one. If `SearchableEntry` carried the body, ranking would require
reading every Resource — six reads per query, scaling linearly with the catalogue. Carrying only
`title + description + keywords` means ranking is a pure string operation over six pre-joined strings,
and the *only* Resources that are ever read are the ones that win. That is what makes the context
budget tractable: you cannot afford to read a Resource you have not chosen.

**Block 5 — the `ResourceCatalogue` interface (lines 202–215).**

```ts
export interface ResourceCatalogue {
  descriptors(): readonly ResourceDescriptor[];
  byName(name: string): ResourceDescriptor | undefined;
  listable(): CatalogueEntry[];
  templates(): readonly ResourceDescriptor[];
  searchable(): readonly SearchableEntry[];
  resolve(uri: string): ResolvedResource | undefined;
  schemeOf(uri: string): string | undefined;
}
```

Seven methods, and the shape of the interface tells you who calls what:

| Method | Caller | Purpose |
| :--- | :--- | :--- |
| `descriptors()` | `mcp/resources.ts`, tests | Everything, in declaration order |
| `byName()` | the ACL, diagnostics | Lookup by the stable identity |
| `listable()` | `mcp/resources.ts` → `resources/list` | The **fixed** entries. Templates are registered separately, and a template's instances come from the registrar's `list` hook (Chapter 15) |
| `templates()` | `mcp/resources.ts` → `resources/templates/list` | Templates only |
| `searchable()` | `services/selectionService.ts` | The ranker's pre-joined haystacks |
| `resolve()` | the read path, the ACL | Concrete URI → descriptor + variables |
| `schemeOf()` | `host/policy.ts` | *The first check the policy runs* |

The `listable` / `templates` split is the one that maps onto the protocol. MCP has two listing verbs —
`resources/list` and `resources/templates/list` — and a catalogue entry belongs to exactly one of them.
Keeping the split here, rather than in the registrar, means the registrar is a two-line mapping and the
rule lives with the data.

Note the return types: `readonly` for `descriptors`, `templates` and `searchable` (the caller must not
reorder the catalogue), and a mutable `CatalogueEntry[]` for `listable` (a fresh array per call, so
mutating it is harmless). The distinction is not decorative — `searchable()` returns the array the
ranker scores, and if a ranker could sort it in place, the *next* query would see a reordered catalogue.

**Block 6 — `compileTemplate` (lines 217–249).**

```ts
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const VARIABLE_SEGMENT = /^\{([A-Za-z0-9_]+)\}$/;
```

Two regexes. `SCHEME` matches a URI scheme per RFC 3986 — letter, then letters/digits/`+`/`.`/`-`, then
a colon. `VARIABLE_SEGMENT` matches a segment that is **entirely** a variable: `{` name `}` and nothing
else, anchored with `^...$`. That anchoring is the whole grammar decision.

```ts
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
```

The doc comment is the argument for doing it this way rather than with a `replace`:

> Segment-by-segment rather than a naive `replace`, because the grammar matters: a `{var}` occupies a
> **whole segment**, so `task://projects/{projectId}` must not match `task://projects/fde/extra`. A glob
> would, and **a glob is how a template quietly becomes an enumeration oracle over a path space nobody
> intended to expose** (Notes Ch04 §"Validate and constrain dynamic URIs").

That is the security argument, and it is concrete. Consider a template compiled as a glob —
`task://projects/*` — which matches `task://projects/fde/extra`, `task://projects/fde/../media`,
`task://projects/../../etc/passwd`. The template stops describing a family of *project briefs* and
starts accepting an unbounded path space. Someone has to validate what arrives, and if nobody does,
the Resource layer becomes a file-traversal surface.

Four details of the implementation:

**1. `split("/")` then re-`join("/")`.** The template is decomposed into segments, each is transformed,
and they are reassembled. This is what makes "a `{var}` occupies a whole segment" enforceable — the
test runs against one segment at a time, so a variable embedded in a longer segment simply fails
`VARIABLE_SEGMENT` and is treated as a literal.

**2. Literal segments are regex-escaped.** `segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` escapes every
regex metacharacter. Without it, a literal `.` in a URI would match any character — so
`task://projects/fde` would also match `task://projectsXfde`. The character class is the standard
"all metacharacters" set, and `"\\$&"` inserts a backslash before the match.

**3. A variable becomes `([^/]+)` — one or more non-slash characters.** `[^/]` is what keeps the
variable inside its segment; `+` requires at least one character, so `task://projects/` does not match.
And because the variable cannot contain `/`, `task://projects/fde/extra` cannot match a template whose
variable is the last segment.

**4. The whole pattern is anchored.** `` new RegExp(`^${pattern}$`) `` — the `^` and `$` are what make
this a *whole-URI* match rather than a substring search. Without them, `task://guidelines` would match
`x-task://guidelines-y`.

**The `names` array is positional, and that is the contract with `resolve`.** Each variable pushes its
name as it is encountered, so `names[i]` corresponds to capture group `i + 1` in the compiled pattern.
The two must stay in step, and they do because they are built in the same `.map()`.

Note the `variable[1] === undefined` guard. It is unreachable in practice — `VARIABLE_SEGMENT` has one
capture group and a successful match always populates it — but `noUncheckedIndexedAccess` types
`variable[1]` as `string | undefined`, so the branch must exist. The fallback returns the segment
unchanged, which is the safe behaviour: an unparseable variable is treated as a literal rather than
producing a `(undefined)` capture.

**Block 7 — the constructor (lines 251–337).**

```ts
export function createResourceCatalogue(
  descriptors: readonly ResourceDescriptor[] = RESOURCE_DESCRIPTORS,
): ResourceCatalogue {
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

  const compiled = new Map<string, { pattern: RegExp; names: string[] }>(
    descriptors
      .filter((descriptor) => descriptor.kind === "template")
      .map((descriptor) => [descriptor.uri, compileTemplate(descriptor.uri)]),
  );
  ...
}
```

The **default parameter** is what makes this testable: `createResourceCatalogue()` uses the real table,
and `createResourceCatalogue([...])` builds a catalogue from any descriptor list. A test for the ACL can
invent a two-descriptor catalogue instead of reasoning about the real six.

Two indices are built once, and both exist for the same reason — keeping work off the hot path:

**`byName`** is a name → descriptor `Map`. `byName.get(name)` is O(1) instead of a `find` over six
entries. Six is small; the point is that the ACL calls this on every read, and the pattern is what
matters when the catalogue is ten thousand entries.

**`compiled`** is the more interesting one, and its comment states the trade:

> Compile every template once, at construction. The alternative — compiling on each `resolve` — puts a
> `new RegExp` on the hot path of every policy check.

A `new RegExp` per call is a real cost: it parses and compiles a pattern, and it happens on *every*
policy check, every ACL decision, every audit label. Doing it six times at boot and never again is the
whole optimisation, and it is only available because the template set is fixed — which is exactly what
having a descriptor table buys.

The filter/map pair is precise: only `kind === "template"` descriptors are compiled, because only they
have a pattern. A static or dynamic URI is compared with `===` in `resolve`, not matched against a
regex.

**`toEntry`** (lines 261–268) is a small projection from `ResourceDescriptor` to `CatalogueEntry`,
naming the six fields that go on the wire. Writing it as a function rather than inlining the object
literal in `listable` means the wire shape is defined in one place — a new field in the descriptor does
not leak into `resources/list` unless someone adds it here deliberately.

**`resolve` — the matching loop (lines 296–327).**

```ts
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
        variables[name] = decodeURIComponent(value);
      }
    });

    return { descriptor, variables };
  }

  return undefined;
}
```

One pass over the descriptors, with two branches — exact match for non-templates, regex match for
templates. **Non-templates are checked first, within the same loop**, so a static URI is found by string
comparison even if it were also somehow template-like.

Three details:

**`return undefined` at the end is the "not found" answer**, and it is a value rather than a throw. The
caller decides what that means: the read path turns it into `NOT_FOUND`; the ACL turns it into
`FORBIDDEN`; the selection engine skips it. One function, three meanings, decided by the layer that
knows the context.

**`decodeURIComponent` on each captured value** — and the comment explains why:

> Decode, because a URI segment may be percent-encoded and a variable that arrives as `%20` would
> otherwise be a different resource from the one the caller meant.

So `task://projects/my%20project` resolves with `projectId === "my project"`, and the renderer gets the
value the caller meant. Without the decode, the renderer would look for a project literally named
`my%20project` — a subtly wrong answer rather than an error, which is the worst kind.

**`variables[name] = value`** is keyed by the template's own variable names, taken from `matcher.names`.
The renderer receives a named record — `{ projectId: "fde" }` — not a positional array, so it never has
to know the order the variables appeared in.

**`schemeOf` (lines 329–332).**

```ts
schemeOf(uri) {
  const match = SCHEME.exec(uri);
  return match?.[1]?.toLowerCase();
},
```

Three lines, and it is the *first* check the policy runs. It returns `string | undefined` — `undefined`
for a URI with no scheme at all (e.g. `not-a-uri`), which the policy treats as a refusal.

The double optional chain `match?.[1]?.toLowerCase()` is the `noUncheckedIndexedAccess` idiom: `exec`
returns `null` on no match, and even on a match the capture group is typed `string | undefined`. Both
branches collapse to `undefined`, which is the right answer for "this is not a URI I recognise".

The **lower-casing** is why `config/env.ts` normalises the scheme allowlist to lower case (Chapter 02).
Schemes are case-insensitive per RFC 3986, so `TASK://backlog` and `task://backlog` are the same URI —
and normalising both sides is what makes the comparison a single `Set.has` rather than a case-insensitive
search.

---

## Run / verify

### 1. What the catalogue advertises

```bash
npm run lifecycle 2>/dev/null | sed -n '/^4\./,/^5\./p'
```

```text
4. resources/list -> metadata only: the client knows what exists, not what it says
   task://guidelines              Company rules for prioritising and scheduling tasks: when to do deep w…(+112)
   task://backlog                 Every task that is not done yet, with its priority, project and owner.…(+75)
   task://summary                 Counts of open tasks by priority, plus the projects they belong to and…(+100)
   task://projects/fde            Every task in one project, open and completed, addressed by project id…(+58)
   task://projects/media          Every task in one project, open and completed, addressed by project id…(+58)
   task://tasks/1                 One task as addressable JSON, addressed by numeric id. This is how a f…(+61)
   task://tasks/2                 One task as addressable JSON, addressed by numeric id. This is how a f…(+61)
   task://tasks/3                 One task as addressable JSON, addressed by numeric id. This is how a f…(+61)
   task://tasks/4                 One task as addressable JSON, addressed by numeric id. This is how a f…(+61)
   task://projects/{projectId}    (template) Every task in one project, open and completed, addressed by …(+68)
   task://tasks/{taskId}          (template) One task as addressable JSON, addressed by numeric id. This …(+71)
   user://{userId}/profile        (template) One person's profile and open workload, addressed by user id…(+54)
```

Twelve lines: **nine instances and three templates.** And the arithmetic is traceable to the two
files involved:

| Source | Count | Produces |
| :--- | :--- | :--- |
| `catalogue.listable()` — the three non-template descriptors | 3 | `guidelines`, `backlog`, `summary` |
| The `task` template's `list` hook — `deps.tasks.list()` | 4 | `task://tasks/1` … `task://tasks/4` |
| The `project` template's `list` hook — `deps.tasks.stats().projects` | 2 | `projects/fde`, `projects/media` |
| The `user-profile` template's `list` hook — **absent** | 0 | *nothing, deliberately* |
| | **9** | plus 3 templates = **12** |

**Every description is identical across a template's instances.** All four `task://tasks/N` lines carry
the same text, because that text belongs to the *descriptor*, not the instance — which is the
descriptor/instance split visible in the output. The instance contributes only its `title` (`"Write MCP
notes"`, from the task itself).

**And `user://{userId}/profile` appears once, as a template, with no instances.** That is the
enumeration-oracle defence in action. The line the lifecycle prints is the descriptor's own warning:
*"Personal data: only the owner of the id may read it."* A client can read a profile it already has an
id for; it cannot ask for the set of all of them.

### 2. The same catalogue over HTTP

```bash
curl -s http://127.0.0.1:8080/resources
```

```json
{"resources":[{"uri":"task://guidelines","name":"guidelines",...},
 {"uri":"task://projects/fde","name":"project-fde","title":"Project fde",...},
 {"uri":"task://tasks/1","name":"task-1","title":"Write MCP notes","mimeType":"application/json"},
 ...],
 "templates":[{"uriTemplate":"task://projects/{projectId}","name":"project",...},
 {"uriTemplate":"user://{userId}/profile","name":"user-profile",...}],
 "count":12}
```

Two naming conventions to notice, both produced by the registrar rather than the catalogue:

| Kind | `name` | `title` |
| :--- | :--- | :--- |
| Fixed | `guidelines` (the descriptor's name) | The descriptor's title |
| Template instance | `project-fde`, `task-1` (**derived**) | `Project fde`, `Write MCP notes` (**from live state**) |

The instance names are *derived from the variable* — `project-${project}`, `task-${task.id}` — so they
are stable and unique without anyone maintaining a list. And `title: "Write MCP notes"` comes from the
actual task, which is why the listing reflects live state rather than a hard-coded table.

### 3. The template grammar, tested

This is the security-relevant behaviour, and it is directly observable:

```bash
for u in 'task://projects/fde' 'task://projects/fde/extra' 'task://projects/' 'task://projects/my%20project'; do
  printf '%-34s -> %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080/read?uri=$u")"
done
```

```text
task://projects/fde                -> 200
task://projects/fde/extra          -> 404
task://projects/                   -> 404
task://projects/my%20project       -> 400
```

Four outcomes, and each one is a specific rule from `compileTemplate`:

**`fde` → 200.** The variable matches `([^/]+)`: one or more non-slash characters. ✓

**`fde/extra` → 404.** This is the anti-glob property, and it is the whole reason for compiling
segment-by-segment. A pattern of `task://projects/*` would have matched, and the template would have
become an enumeration oracle over an unbounded path space. The response body says which layer refused:

```json
{"error":{"code":"NOT_FOUND","message":"Refused to read task://projects/fde/extra — the URI does not match any advertised Resource.","recovery":"Call GET /resources to read the advertised URIs, then retry with one of them.","retryable":false,"requestId":"18800697"}}
```

Note *"Refused to read"* — the **host** refused it, from its own copy of the catalogue, before the
wire. The client never reached the server's matcher, which is the "a host that can predict a failure
predicts it" principle (Chapter 25).

**`task://projects/` → 404.** The variable is `+` (one or more), so an empty segment does not match. A
`*` quantifier would have accepted it.

**`my%20project` → 400 — and this is the most interesting one.** The template **matched** (so
`decodeURIComponent` ran, turning `my%20project` into `my project`), and then validation rejected the
value:

```json
{"error":{"code":"INVALID_INPUT","message":"Invalid projectId in the resource URI — projectId must be a slug: letters, digits, dash or underscore.","recovery":"Supply a projectId that satisfies the template, or list the catalogue with resources/list.","retryable":false,"requestId":"b199448a"}}
```

Three layers are visible in that single response:

1. **The matcher accepted it** — otherwise this would be a 404, not a 400.
2. **`decodeURIComponent` ran** — the message reports `projectId`, not `projectId=%20`.
3. **The schema rejected the decoded value** — `projectId` must be a slug.

That is defence in depth with the layers doing different jobs. The template's job is to say *what shape
of address exists*; the schema's job is to say *which values are meaningful*. A slug constraint cannot
be expressed as a URI pattern (`([^/]+)` accepts spaces, once decoded), so the two checks are genuinely
complementary rather than redundant — and the 400/404 distinction is exactly the Chapter 05 taxonomy
working: *a well-formed address with a bad value* is not the same as *an address that does not exist*.

### 4. Typecheck

```bash
npm run typecheck && echo PASS
```

```text
PASS
```

`compileTemplate` is the densest function in this file and the typecheck is what keeps it honest —
particularly `variable[1]` and `match[index + 1]`, both of which are `string | undefined` under
`noUncheckedIndexedAccess` and both of which are guarded explicitly rather than asserted.

---

## Checkpoint

1. **What is the difference between a descriptor and an instance, and why does it matter?**
   A descriptor is written by hand and changes when the API changes; instances are computed from live
   state and change constantly. Keeping them apart lets six descriptors serve an unbounded family of
   addresses, and lets three other layers reason about Resources without reading any content.

2. **Which three layers consume the catalogue, and what does each need from it?**
   `selectionService` ranks descriptors; `host/policy.ts` authorises against the audience declaration
   *before* a handler runs; `host/audit.ts` names what was chosen without storing what it said.

3. **Why does `{var}` have to occupy a whole segment?**
   Because a glob is how a template becomes an enumeration oracle over a path space nobody intended to
   expose. `task://projects/{projectId}` must not match `task://projects/fde/extra` — verified above,
   where that URI returns 404.

4. **What does `SearchableEntry` deliberately not contain, and why?**
   Content. Retrieval embeds Resource *metadata* — title, description, keywords — so ranking is possible
   before anything is read. If it carried bodies, ranking would require reading every Resource, and the
   context budget would be unmanageable.

5. **Why is the compiled-template `Map` built at construction rather than in `resolve`?**
   Because `resolve` is called on every policy check and every ACL decision. A `new RegExp` per call
   parses and compiles a pattern each time; compiling six templates once at boot is the entire
   optimisation, and it is only possible because the template set is fixed.

6. **What does `decodeURIComponent` change about matching, and what catches the result?**
   It turns `my%20project` into `my project`, so the renderer receives the value the caller meant rather
   than a percent-encoded string — which would have been a subtly wrong answer instead of an error.
   What catches a bad decoded value is the schema at the next layer (`projectId` must be a slug), which
   is why `my%20project` returns 400 rather than 404.

7. **Why does `schemeOf` lower-case its result?**
   Schemes are case-insensitive per RFC 3986, so `TASK://` and `task://` are the same URI. Normalising
   both sides is what makes the allowlist check a single `Set.has` — and it is why `config/env.ts`
   lower-cases the scheme list when it parses `.env`.

---

**[← Chapter 07: The Task Store](./07_Domain_Task_Store.md)** · **[Chapter 09: The Task Service →](./09_Service_Task_Service.md)**

# Chapter 05 — Resource Selection: How the App Chooses

> **Goal of this chapter:** answer the question the lecture asks most insistently — *given a
> catalogue and a user message, what code decides which Resources to read?* This file is the
> answer, and it is ordinary application code with no MCP in it at all.
>
> **Lecture chapter:** [05 — How the Application Chooses a Resource](../../../notes/05_How_the_Application_Chooses_a_Resource.md).

---

## 5.1 File details

| | |
|---|---|
| **Path** | `src/services/resourceSelector.ts` |
| **Purpose** | decide which Resources a message needs, and record *why* |
| **Imports** | none — no MCP, no model, no I/O |
| **Exports** | `CatalogueEntry`, `ResourceChoice` (types); `byUserChoice`, `byAppState`, `byRetrieval`, `selectResources` |
| **Depends on** | nothing in `src/` |
| **Called by** | `src/client/client.ts` (`ask()`) |
| **Implements** | Lecture 05 (all five selection strategies; four implemented) |

## 5.2 Commands

```bash
npx tsx -e "
import('./src/services/resourceSelector.ts').then((s) => {
  const catalogue = [
    { uri: 'task://guidelines', description: 'Company rules' },
    { uri: 'task://backlog', description: 'Every open task' },
    { uri: 'task://summary', description: 'Counts by priority' },
  ];
  for (const m of ['plan my day', 'how busy am I?', 'what is on my plate?', 'hello']) {
    console.log(m, '->', JSON.stringify(s.selectResources(m, catalogue)));
  }
});
"
```

---

## 5.3 Full file

**Path:** `src/services/resourceSelector.ts`

```ts
/**
 * Chapter 05 — MCP does not choose Resources. Your APPLICATION does.
 *
 * That is the whole chapter in one file: the protocol gives you a catalogue,
 * and picking from it is ordinary application code. Four of the five strategies
 * from the notes are implemented here; the fifth (LLM routing) is left out
 * because it needs a model inside the selection path, which is exactly the
 * trade-off Chapter 05 warns about.
 */
export type CatalogueEntry = { uri: string; description: string };

export type ResourceChoice = { uri: string; strategy: string; reason: string };

/** Chapter 05 — strategy 5, the cheap version: keywords in the user's message. */
const KEYWORDS: Record<string, string[]> = {
  "task://guidelines": ["policy", "guideline", "rule", "priority", "prioriti", "schedule", "should i"],
  "task://backlog": ["task", "backlog", "to-do", "todo", "pending", "plate", "work"],
  "task://summary": ["how many", "how busy", "summary", "overview", "workload"],
};

/**
 * Strategy 1 — the user picked it. This always wins: an explicit choice beats
 * any guess the application could make.
 */
export function byUserChoice(uri: string): ResourceChoice {
  return { uri, strategy: "user selection", reason: "the user asked for this Resource explicitly" };
}

/**
 * Strategy 2 — application state. The application knows things the user did not
 * say: every planning request needs the rules, whoever asked and however.
 */
export function byAppState(message: string): ResourceChoice[] {
  if (!/plan|prioriti|schedule|busy|workload/i.test(message)) {
    return [];
  }

  return [
    {
      uri: "task://guidelines",
      strategy: "application state",
      reason: "a planning request always needs the rules, even when the user does not mention them",
    },
  ];
}

/**
 * Strategy 4 — retrieval. Score the catalogue against the message and take the
 * entries that match. Cheap, explainable, and good enough for a small server.
 */
export function byRetrieval(message: string, catalogue: CatalogueEntry[]): ResourceChoice[] {
  const text = message.toLowerCase();

  return catalogue
    .filter((entry) => (KEYWORDS[entry.uri] ?? []).some((keyword) => text.includes(keyword)))
    .map((entry) => ({
      uri: entry.uri,
      strategy: "retrieval",
      reason: `the message mentions "${entry.uri}" keywords`,
    }));
}

/**
 * The one function the host calls. Order matters: rules before retrieval, so a
 * required Resource is never dropped just because the wording did not match.
 * Duplicates collapse to the first (strongest) strategy that chose them.
 */
export function selectResources(message: string, catalogue: CatalogueEntry[]): ResourceChoice[] {
  const chosen = [...byAppState(message), ...byRetrieval(message, catalogue)];

  const unique = new Map<string, ResourceChoice>();
  for (const choice of chosen) {
    if (!unique.has(choice.uri)) {
      unique.set(choice.uri, choice);
    }
  }

  return [...unique.values()];
}
```

---

## 5.4 The five strategies, and where each one lives

Lecture 05 names five ways an application can pick a Resource. Here is the honest mapping:

| # | Strategy (notes) | In this file? | Why |
|---|---|---|---|
| 1 | **User selection** — the user clicked it | ✅ `byUserChoice()` | Trivial and decisive; it must win over everything |
| 2 | **Application state** — the app knows the workflow | ✅ `byAppState()` | The interesting one: the app knows things the user never said |
| 3 | **Rules** — a fixed mapping from intent to Resource | ✅ folded into `byAppState()` | A rule *is* "app state + pattern"; one function covers both |
| 4 | **Retrieval** — score the catalogue against the message | ✅ `byRetrieval()` | Keyword scoring: the cheap, explainable version |
| 5 | **LLM routing** — let a model choose | ❌ deliberately absent | It puts a model inside the selection path |

**Why strategy 5 is left out on purpose.** The lecture warns that letting a model choose the
context is powerful and expensive: it costs a model call before every real call, it is
non-deterministic, and it is hard to test. This project implements the other four so the file
stays runnable offline and gives the *same* answer every time — which is exactly the trade-off
the chapter asks you to weigh.

---

## 5.5 Block-by-block explanation

### Block 1 — the two types

```ts
export type CatalogueEntry = { uri: string; description: string };

export type ResourceChoice = { uri: string; strategy: string; reason: string };
```

- `CatalogueEntry` is the **input**: the shape of what `resources/list` returned. It is declared
  here rather than imported from the MCP SDK on purpose — this file must not depend on the
  protocol. `src/client/client.ts` does the adapting (see Chapter 08).
- `ResourceChoice` is the **output**: not just *which* Resource, but **`strategy`** and
  **`reason`**.
- **Why carry the reason?** Two practical payoffs:
  1. It is *observable*. The `/ask` route prints `chosen by application state` / `chosen by
     retrieval`, so you can see the decision instead of guessing at it.
  2. It is *debuggable*. When the wrong context shows up in an answer, the reason string tells
     you which rule fired.
- A bare `string[]` of URIs would have been shorter and much worse.

### Block 2 — the keyword table

```ts
const KEYWORDS: Record<string, string[]> = {
  "task://guidelines": ["policy", "guideline", "rule", "priority", "prioriti", "schedule", "should i"],
  "task://backlog": ["task", "backlog", "to-do", "todo", "pending", "plate", "work"],
  "task://summary": ["how many", "how busy", "summary", "overview", "workload"],
};
```

- `Record<string, string[]>` is TypeScript's "object with string keys, array-of-string values".
  Keyed by **URI** so the lookup in `byRetrieval` is a single index.
- The keys are the three fixed Resources. The two **templates are absent on purpose**: you cannot
  match a keyword against `task://projects/{projectId}`, because you do not know the id yet.
  Choosing a template is a different problem — it needs a variable, which is exactly why
  `byUserChoice` exists.
- Two details worth copying:
  - `"prioriti"` is a deliberate **stem**. It matches *prioritise*, *prioritize*, *priority* and
    *priorities* with one entry. A crude stem is often better than a long list of inflections.
  - `"should i"` is a **phrase**, and `text.includes("should i")` matches it as a phrase because
    the whole message is lower-cased first. Multi-word keywords work with no extra machinery.
- **The honest limitation:** this is keyword matching, not understanding. It will fire on
  *"ignore the guidelines"* too. Chapter 12's reranking material is the upgrade path; for a
  five-Resource catalogue, keywords are the right size of solution.

### Block 3 — strategy 1, user selection

```ts
export function byUserChoice(uri: string): ResourceChoice {
  return { uri, strategy: "user selection", reason: "the user asked for this Resource explicitly" };
}
```

- The shortest function in the project, and the most important one. When a user clicks
  *"attach the guidelines"* in a UI, nothing should be able to overrule it — not retrieval, not
  a model.
- It takes a URI and returns a `ResourceChoice` unchanged. **That is the point:** an explicit
  choice needs no scoring, no ranking and no confidence. It is a fact, not an inference.
- It is **not** called by `selectResources()` below, because this project has no UI to click.
  It is called directly by the host when a user passes `?uri=` to `/read`. Keeping it here
  documents the strategy next to its four siblings — and makes it obvious that strategy 1 is a
  different kind of thing from strategies 2–5.

### Block 4 — strategy 2, application state

```ts
export function byAppState(message: string): ResourceChoice[] {
  if (!/plan|prioriti|schedule|busy|workload/i.test(message)) {
    return [];
  }

  return [
    {
      uri: "task://guidelines",
      strategy: "application state",
      reason: "a planning request always needs the rules, even when the user does not mention them",
    },
  ];
}
```

- **This is the heart of Chapter 05.** The application knows something the user did not say:
  *any request about planning needs the rules.* The user types *"plan my day"* and never
  mentions guidelines — and still gets them, because the application decided.
- `/plan|prioriti|schedule|busy|workload/i` is a **regular expression**. The `/…/` delimiters
  hold the pattern and the trailing `i` flag makes it case-insensitive, so *"Plan"* and *"PLAN"*
  both match. `.test(message)` returns a boolean.
- The leading `!` inverts it: *if the message matches none of those words, return an empty
  array.* The early return keeps the happy path unindented.
- `[]` rather than `null` — the caller can always spread the result
  (`[...byAppState(m), ...byRetrieval(m, c)]`) with no null check. Returning an empty collection
  instead of a nullish value is what makes the composition in Block 6 clean.
- The `reason` string is the teaching text: *"even when the user does not mention them"*. That
  sentence is the difference between a Tool and a Resource in one line.

### Block 5 — strategy 4, retrieval

```ts
export function byRetrieval(message: string, catalogue: CatalogueEntry[]): ResourceChoice[] {
  const text = message.toLowerCase();

  return catalogue
    .filter((entry) => (KEYWORDS[entry.uri] ?? []).some((keyword) => text.includes(keyword)))
    .map((entry) => ({
      uri: entry.uri,
      strategy: "retrieval",
      reason: `the message mentions "${entry.uri}" keywords`,
    }));
}
```

- **This is where the description comes back.** `byRetrieval` takes the *catalogue* — the live
  result of `resources/list` — so adding a Resource to `resources.ts` (Chapter 04) automatically
  makes it selectable, provided you also add its keywords here. That is the smallest possible
  version of a retrieval pipeline, and it is enough for five Resources.
- `message.toLowerCase()` is hoisted into `text` and computed **once**, outside the loop. Doing
  it inside the predicate would re-lower-case the same string for every catalogue entry.
- The predicate is two nested array methods, and it reads inside-out:
  - `.some((keyword) => text.includes(keyword))` — *"does this entry have at least one keyword
    in the message?"*
  - `.filter(...)` keeps the entries where that is `true`.
- **`KEYWORDS[entry.uri] ?? []`** is the important safety net. A catalogue entry with no keyword
  list (for example a newly added Resource, or a template if it ever appeared here) yields
  `undefined`, and `.some` on `undefined` would throw. `?? []` turns "no keywords" into "no
  match" — the correct behaviour, with no crash.
- `.map(...)` then converts each surviving entry into a `ResourceChoice`, attaching the strategy
  and a human-readable reason that names the URI.
- **Note what retrieval does *not* do:** it never invents a URI. It can only return entries the
  server actually advertised. A selection strategy that hallucinated a URI would produce a
  `resources/read` that fails — a failure mode worth avoiding by construction.

### Block 6 — the composer

```ts
export function selectResources(message: string, catalogue: CatalogueEntry[]): ResourceChoice[] {
  const chosen = [...byAppState(message), ...byRetrieval(message, catalogue)];

  const unique = new Map<string, ResourceChoice>();
  for (const choice of chosen) {
    if (!unique.has(choice.uri)) {
      unique.set(choice.uri, choice);
    }
  }

  return [...unique.values()];
}
```

- **One function, and it is the only one the host calls.** Everything above is a strategy;
  this is the policy.
- `[...byAppState(message), ...byRetrieval(message, catalogue)]` concatenates the two result
  arrays into one. **The order is the priority order**: rules first, then retrieval. If both
  chose `task://guidelines`, the rule's reason survives.
- The de-duplication loop is the part to read carefully:
  - `new Map<string, ResourceChoice>()` — keyed by URI.
  - `if (!unique.has(choice.uri)) unique.set(choice.uri, choice)` — **only the first writer
    wins**, and `.set()` on an existing key would overwrite. So iterating in priority order is
    what makes the strongest strategy stick.
  - `[...unique.values()]` turns the Map's values back into an array. A `Map` preserves
    **insertion order**, so the output order is deterministic: rules first, then retrieval hits
    in catalogue order.
- **Why de-duplicate at all?** Without it, a message like *"how busy am I with my workload?"*
  could select `task://summary` twice and you would pay for two identical `resources/read` calls
  and send the same context to the model twice. Deduplication here is a cost control, not a
  nicety.
- **Why not just call the strategies and skip the composer?** Because every caller would then
  have to remember the priority order and the dedup rule. Encoding the policy in one function is
  what makes Chapter 08's `ask()` a three-line loop.

---

## 5.6 Trace: what the selector actually does

Run the command from §5.2 and you get exactly this (verified output):

```text
plan my day            -> task://guidelines [application state]
how busy am I?         -> task://guidelines [application state], task://summary [retrieval]
what is on my plate?   -> task://backlog [retrieval]
hello                  -> (none)
```

Read each line as a lesson:

| Message | Result | What it proves |
|---|---|---|
| `plan my day` | `guidelines` via **application state** | the app supplied context the user never asked for |
| `how busy am I?` | `guidelines` + `summary` | two strategies **composed**; `busy` hit the rule, `how busy` hit retrieval |
| `what is on my plate?` | `backlog` via **retrieval** | keyword matching on an idiomatic phrase (`plate`) |
| `hello` | **nothing** | selecting zero Resources is a valid, correct outcome |

The last row matters as much as the others: a message that needs no context gets no context.
Sending all five Resources on every turn is the most common way to waste a context window and
bury the actual question.

---

## 5.7 What this means for the lecture's argument

Chapter 05's thesis is: **MCP does not choose the Resource — your application does.** This file
is that thesis compiled.

- The MCP server (Chapter 04) advertises a **catalogue**. It has no opinion about which entry
  matters.
- The protocol (Chapter 03) delivers `resources/list` and `resources/read`. It has no opinion
  either.
- The **application** owns the decision — and in this project that decision is 79 lines of
  ordinary TypeScript with no protocol imports at all.

That is why `resourceSelector.ts` lives in `services/` and not in `resources/`. It is not a
server concern. Every host you ever write will have its own version of this file, and the
protocol will never care how you wrote it.

---

## 5.8 Run / verify

```bash
npx tsx -e "
import('./src/services/resourceSelector.ts').then((s) => {
  const catalogue = [
    { uri: 'task://guidelines', description: 'Company rules' },
    { uri: 'task://backlog', description: 'Every open task' },
    { uri: 'task://summary', description: 'Counts by priority' },
  ];
  for (const m of ['plan my day', 'how busy am I?', 'what is on my plate?', 'hello']) {
    console.log(m, '->', JSON.stringify(s.selectResources(m, catalogue)));
  }
});
"
```

To see it working **live**, through the whole stack, use the `/ask` route (Chapter 09):

```bash
curl -s --get --data-urlencode 'message=how busy am I today?' 'http://127.0.0.1:8080/ask'
```

The offline response shows the reasons in the context header:

```text
--- task://guidelines (chosen by application state) ---
Task Management Guidelines:
...

--- task://summary (chosen by retrieval) ---
Open tasks: 3
High priority: 1
...
```

That `(chosen by …)` annotation is the `strategy` field doing its job.

---

## 5.9 Checkpoint

1. **Which of the five strategies is deliberately missing, and why?** → LLM routing; it needs a
   model call inside the selection path, which is slow, non-deterministic and expensive.
2. **Why does `byAppState` return `[]` instead of `null`?** → so the caller can spread it
   unconditionally when composing strategies.
3. **Why does `selectResources` de-duplicate with a `Map` instead of a `Set`?** → a `Set` would
   keep the URI but lose the `strategy`/`reason`. The `Map` keeps the whole choice, and
   `if (!has) set` means the strongest strategy (rules before retrieval) wins.
4. **Could retrieval ever return a URI the server does not have?** → no. It filters the live
   catalogue, so it can only return advertised entries.
5. **Why is this file in `services/` and not `resources/`?** → it is application policy, not a
   server capability. It imports nothing from the MCP SDK.

**Next:** [Chapter 06 — Prompts: Reusable Templates with Arguments](./06_Prompts_Reusable_Templates_with_Arguments.md)




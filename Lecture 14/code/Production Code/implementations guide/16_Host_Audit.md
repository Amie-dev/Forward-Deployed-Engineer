# Chapter 16: Host — The Audit Trail

> **Chapter goal:** Answer *"who ran what, on whose authority, and how do I prove it?"* — while
> storing a hash of the arguments instead of the arguments.

---

## 16.1 File details

| | |
| :--- | :--- |
| **Path** | `src/host/audit.ts` |
| **Layer** | host (imports `node:crypto`, `type Logger`, `type TrustTier`) |
| **Purpose** | Build one audit record per attempted call — decision, outcome, hashed arguments, duration — and log it alongside keeping it in memory |
| **Imports** | `createHash` from `node:crypto`, `type Logger`, `type TrustTier` |
| **Exports** | `type AuditRecord`, `interface AuditEntry`, `interface AuditLog`, `hashArgs()`, `createAuditLog()` |
| **Consumed by** | `src/host/client.ts` |
| **Lecture sections** | [08 — Security and production](../../../notes/08_Security_Production_and_Practical_Architecture.md) §"Observability" and §"Never log raw tokens or full tool arguments" |

### Commands

```bash
cd "Lecture 14/code/Production Code"

# the record table the host prints at the end
npm run host | sed -n '42,52p'

# the same records as structured log lines
npm run host 1>/dev/null 2>&1 | grep '"event":"audit"' | head -3
```

---

## 16.2 Full file

```ts
import { createHash } from "node:crypto";
import type { Logger } from "../core/logger.js";
import type { TrustTier } from "./policy.js";

/**
 * Chapter 08 — *"who is allowed to run this tool, on whose authority, and how do
 * I prove it after the fact?"*
 *
 * The third clause is the one teams skip, and the one an incident review asks
 * for first. An audit record answers *who asked for what, what the host decided,
 * and how it ended* — **without storing the arguments.**
 *
 * Arguments are hashed instead, because they routinely carry a name, an email or
 * a token. The digest is enough to correlate a retry, spot a replay and prove
 * that two calls were identical; it is useless for reconstructing the data, and
 * useless to anyone who steals the log.
 */

export type AuditRecord = {
  at: string;
  actor: string;
  tool: string;
  /** What the host decided, before anything ran. */
  decision: TrustTier | "blocked";
  outcome: "ok" | "error" | "denied";
  /** Truncated SHA-256 of the canonicalised arguments — never the arguments. */
  argsHash: string;
  durationMs: number;
};

export interface AuditEntry {
  actor: string;
  tool: string;
  decision: AuditRecord["decision"];
  outcome: AuditRecord["outcome"];
  args: Record<string, unknown>;
  durationMs: number;
}

export interface AuditLog {
  record(entry: AuditEntry): AuditRecord;
  entries(): AuditRecord[];
}

/**
 * Canonicalises before hashing, so `{a:1,b:2}` and `{b:2,a:1}` produce the same
 * digest. Without this, "were these two calls identical?" — the only question
 * the hash exists to answer — has a wrong answer half the time.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}

export function createAuditLog(logger: Logger): AuditLog {
  const records: AuditRecord[] = [];

  return {
    record(entry) {
      const record: AuditRecord = {
        at: new Date().toISOString(),
        actor: entry.actor,
        tool: entry.tool,
        decision: entry.decision,
        outcome: entry.outcome,
        argsHash: hashArgs(entry.args),
        durationMs: Math.round(entry.durationMs),
      };

      records.push(record);

      // The same line goes to the audit trail *and* the log stream: one is the
      // queryable record, the other is what an operator sees live.
      logger.info("audit", record);

      return record;
    },

    entries() {
      return [...records];
    },
  };
}
```

## 16.3 Block-by-block explanation

### Block 1 — the third clause, and the decision to hash

The header comment quotes the lecture's three-part question and names the part that gets skipped:

> Chapter 08 — *"who is allowed to run this tool, on whose authority, and how do I prove it after the
> fact?"*
>
> The third clause is the one teams skip, and the one an incident review asks for first.

That is worth unpacking, because it explains why this file exists at all. The first two clauses —
*who* and *on whose authority* — are answered by the policy (Chapter 15) in real time. The third is
retrospective: it is asked days later, by someone who was not there, and it cannot be reconstructed
from anything except a record made at the time.

Then the design decision:

> Arguments are hashed instead, because they routinely carry a name, an email or a token. The digest
> is enough to correlate a retry, spot a replay and prove that two calls were identical; it is useless
> for reconstructing the data, and useless to anyone who steals the log.

Three capabilities kept, one capability deliberately given up:

| Question | Can the hash answer it? |
| :--- | :--- |
| Were these two calls identical? | **Yes** — same digest |
| Was this call a retry of an earlier one? | **Yes** — matching digest, later timestamp |
| How many distinct requests did this user make? | **Yes** — count distinct digests |
| What did the user actually ask for? | **No** — and that is the point |

The last row is the security property. A log file is copied to a laptop, shipped to a vendor, attached
to a ticket, retained for years. If it contained raw arguments, every one of those copies would be a
data-protection incident waiting to be discovered. A 16-character digest is not.

**"Useless to anyone who steals the log"** is the sentence to remember. It is the difference between
"we redact sensitive fields" (a policy that will have a gap) and "we never stored the values" (a
property that cannot have a gap).

This is also why Chapter 03's `redact` is described as a *second* line of defence rather than the only
one: the logger redacts by key name, which cannot catch a token hidden in a `note` field. The audit
trail does not store the value at all, so there is nothing to redact.

### Block 2 — `AuditRecord`: the shape of the evidence

```ts
export type AuditRecord = {
  at: string;
  actor: string;
  tool: string;
  /** What the host decided, before anything ran. */
  decision: TrustTier | "blocked";
  outcome: "ok" | "error" | "denied";
  /** Truncated SHA-256 of the canonicalised arguments — never the arguments. */
  argsHash: string;
  durationMs: number;
};
```

**What it does:** declares one row of the audit trail.
**How it works:** seven fields, and the *union types* on two of them carry the interesting design.

**`decision: TrustTier | "blocked"` — a fourth value beyond the policy's three tiers.** Chapter 15's
`TrustTier` is `"auto" | "confirm" | "denied"`. The audit adds `"blocked"`, and the distinction is
real:

| Value | Meaning | Where it comes from |
| :--- | :--- | :--- |
| `"auto"` | the policy allowed it, no gate | `classify` returned `auto` |
| `"confirm"` | the policy asked the user | `classify` returned `confirm` |
| `"denied"` | the policy refused it outright | `classify` returned `denied` — *or* the user declined |
| `"blocked"` | **the host refused before consulting the policy** | a defence-in-depth refusal in `callWithPolicy` |

`"blocked"` exists because `callWithPolicy` (Chapter 17) re-checks the tier before invoking, even
though `visible()` already filtered the catalogue. That re-check is the defence-in-depth layer, and
when it fires it is worth distinguishing from a policy denial — the first means the catalogue filter
was bypassed somehow, the second means it worked. **Collapsing the two would hide the anomaly.**

**`outcome: "ok" | "error" | "denied"` — three values, and note which is absent.** There is no
`"timeout"` and no `"invalid"`: those are `ToolError` codes (Chapter 05) that arrive inside an
`isError: true` result, so they are recorded as `outcome: "error"`. The audit trail answers "how did it
end", not "what went wrong" — the *what* is in the tool result text and in the `tool.failure` log line
(Chapter 10). Two records, two questions, no duplication.

**`argsHash: string` — truncated to 16 hex characters.** Chapter 16's `hashArgs` does the truncation,
and the reason is worth stating here: a full SHA-256 is 64 characters, and the extra 48 characters buy
nothing for the only question being asked. 16 hex characters is 64 bits — collision-resistant enough
for correlating a handful of calls within one session, which is the entire use case. The field is named
`argsHash` rather than `args` so a reader cannot mistake it for the data.

**`at: string`, an ISO 8601 timestamp — not a `Date`.** Same reasoning as `Task.createdAt`
(Chapter 07): a `Date` becomes a string the moment it crosses a serialisation boundary, so declaring
it as a string keeps the type honest. It also sorts lexicographically, which means the records can be
ordered without parsing.

**`durationMs: number`, rounded.** The rounding happens in `record` (Block 5), not here. The field
carries whole milliseconds because that is the resolution anyone reads.

**Why is this a `type` alias rather than an `interface`?** Chapter 05 answered it for `ToolResult`: an
object type alias gets an implicit index signature, and this record is passed to
`logger.info("audit", record)`, whose `Fields` parameter is `Record<string, unknown>`. As an
`interface`, that call would not compile.

### Block 3 — `AuditEntry`: input without the hash

```ts
export interface AuditEntry {
  actor: string;
  tool: string;
  decision: AuditRecord["decision"];
  outcome: AuditRecord["outcome"];
  args: Record<string, unknown>;
  durationMs: number;
}
```

**What it does:** declares what a caller must supply to create a record.
**How it works:** the same fields as `AuditRecord`, minus `at` and `argsHash`, plus the raw `args`.

**The difference between the two types is the whole interface design.** `AuditEntry` has `args`;
`AuditRecord` has `argsHash`. A caller supplies the arguments; the log supplies the digest. That means
**no caller can ever write a record containing raw arguments** — the type system makes it impossible,
because `record()` takes an `AuditEntry` and constructs the `AuditRecord` itself.

That is a pattern worth naming: when a value must never be stored, make the *stored* type not have a
field for it, and let the constructor derive it. A `redact()` call that a caller could forget is a
weaker guarantee than a field that does not exist.

**`at` is likewise absent from the input.** The timestamp is taken by `record()`, from the clock, at the
moment of writing. A caller-supplied timestamp is a caller-supplied lie — and for an audit trail, a
timestamp the caller controls is worse than no timestamp at all.

**`decision: AuditRecord["decision"]` — indexed access types, not a repeated union.** Writing
`TrustTier | "blocked"` again would work, but it would be a second place to update if the union grew.
`AuditRecord["decision"]` reads the type *from* the record, so there is exactly one declaration. Same
for `outcome`. It is the "one source of truth" discipline of `taskSchema` (Chapter 08), applied to a
type rather than a value.

**`args: Record<string, unknown>`, not a typed shape.** The audit log records *every* tool's arguments,
so it cannot know their shape. `Record<string, unknown>` is the honest type for "an arbitrary JSON
object" — and exactly what `hashArgs` needs.

**Why an `interface` here but a `type` for `AuditRecord`?** Because `AuditEntry` is never passed to the
logger — it is only destructured. The implicit-index-signature difference only matters at the
`logger.info` boundary, so the type that crosses it is a `type` and the one that does not is an
`interface`.

### Block 4 — `canonical`: order independence before hashing

```ts
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
```

**What it does:** renders any value as a deterministic string, with object keys sorted.
**How it works:** a recursive walk with three cases, mirroring `redact`'s structure (Chapter 03).

**Why not just `JSON.stringify(args)`?** Because JavaScript object key order is insertion order, and
insertion order depends on how the object was built. Consider two calls a model produced differently:

```ts
JSON.stringify({ title: "Record MCP Video", idempotencyKey: "req-1" })
// '{"title":"Record MCP Video","idempotencyKey":"req-1"}'

JSON.stringify({ idempotencyKey: "req-1", title: "Record MCP Video" })
// '{"idempotencyKey":"req-1","title":"Record MCP Video"}'
```

Same request, different strings, **different digests**. And the digest's entire purpose is to answer
"were these two calls identical?" — so a hash that answers "no" for identical calls is worse than
useless: it is actively misleading during an incident review.

That is what the comment means by *"the only question the hash exists to answer — has a wrong answer
half the time."* Sorting the keys fixes it:

```ts
Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
```

**The three cases, in order:**

1. **`value === null || typeof value !== "object"`** — primitives. `JSON.stringify` handles strings
   (with quotes and escapes), numbers, booleans and `null`. The `?? "null"` covers the one input
   `JSON.stringify` returns `undefined` for: a function, or `undefined` itself. Without it, the template
   literal would interpolate the string `"undefined"` — an inconsistency between two values that should
   both render as absent.

2. **`Array.isArray(value)`** — arrays, with their **existing order preserved**. This is the important
   asymmetry: object keys are sorted, array elements are not. Order in an array is *semantically
   meaningful* (`["a","b"]` is a different request from `["b","a"]`), whereas key order in an object is
   an implementation detail. Sorting arrays would collapse two genuinely different calls onto the same
   digest — the opposite error, and a worse one.

3. **Objects** — keys sorted with `localeCompare`, each key `JSON.stringify`'d (so it is quoted and
   escaped), values recursed.

**The output is a compact string, not pretty-printed.** No spaces, no newlines — it is an intermediate
representation fed straight into a hash, never read by a human.

**Nested objects are handled by recursion, and the sort applies at every level.** A call with
`{ filter: { status: "PENDING", owner: "me" } }` would have the inner keys sorted too — which matters,
because a nested object's key order is just as arbitrary as the top level's.

**What it does not handle:** `Date` objects (their properties are non-enumerable, so they would walk as
empty objects), `Map`/`Set` (same), and circular references (infinite recursion). For this codebase none
of those can appear, because arguments arrive as parsed JSON — a `Date` cannot survive `JSON.parse`. That
is a real constraint worth stating rather than a gap to paper over: **`canonical` assumes
JSON-compatible input.**

### Block 5 — `hashArgs`, and the truncation

```ts
export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}
```

**What it does:** turns an argument object into a short, stable, non-reversible identifier.
**How it works:** canonicalise → SHA-256 → hex → take 16 characters.

**`createHash("sha256")` from `node:crypto`** — a Node built-in, so no dependency. SHA-256 is the right
choice over a fast non-cryptographic hash like `djb2` or `FNV`, and the reason is worth being precise
about: the threat model includes someone with the log who wants to *test a guess*. If an attacker
suspects a call contained a particular email address, a non-cryptographic hash lets them compute the
digest of that guess and compare. SHA-256 makes that infeasible for a low-entropy guess, so the digest
does not become a confirmation oracle. (It is not salted, so a targeted guess against a *known* tool call
is still theoretically possible — which is why the arguments themselves are never logged, and why the
digest is truncated.)

**`.slice(0, 16)` — 64 bits.** The trade-off:

| Length | Collision resistance | Why not |
| :--- | :--- | :--- |
| Full 64 chars | ~2^256 | 48 wasted characters on every log line |
| 16 chars (64 bits) | ~2^32 hashes before a birthday collision | — |
| 8 chars (32 bits) | ~2^16 | Too close to the number of calls in a long session |

The birthday bound is the relevant measure: with 64 bits you would need on the order of four billion
distinct requests before a 50 % chance of any collision — and a collision would only mean two audit rows
looked related when they were not. For correlating a handful of calls within one session, 16 characters
is generous.

**The function is exported, and used in two places.** `record()` calls it, and the run section below
calls it directly to show that two identical `create_task` calls produce the same digest. Exporting it
makes that demonstration possible without reaching into the log.

**`digest("hex")`** — lowercase hex, the conventional rendering, which sorts predictably. A base64 digest
would be shorter but would include `+` and `/`, awkward in log queries and in URLs.

### Block 6 — `createAuditLog`: the record, and the two destinations

```ts
export function createAuditLog(logger: Logger): AuditLog {
  const records: AuditRecord[] = [];

  return {
    record(entry) {
      const record: AuditRecord = {
        at: new Date().toISOString(),
        actor: entry.actor,
        tool: entry.tool,
        decision: entry.decision,
        outcome: entry.outcome,
        argsHash: hashArgs(entry.args),
        durationMs: Math.round(entry.durationMs),
      };

      records.push(record);

      // The same line goes to the audit trail *and* the log stream: one is the
      // queryable record, the other is what an operator sees live.
      logger.info("audit", record);

      return record;
    },

    entries() {
      return [...records];
    },
  };
}
```

**What it does:** builds a record from an entry, stores it, logs it, and returns it.
**How it works:** a closure holding one array, exactly like `createTaskStore` (Chapter 07).

**The record is built field by field, not spread.** `{ ...entry, argsHash: ... }` would be shorter, but it
would also copy `args` into the record — the one field that must not be there. Listing the fields
explicitly makes the omission visible: a reader can see that `args` is used *only* to compute the hash,
and that `at` is generated here rather than accepted. **An explicit field list is a security control when
the input type is a superset of the output type.**

**`at: new Date().toISOString()`** — the timestamp is taken inside `record()`, from the clock, at the
moment of writing. This mirrors `stamp()` in `taskStore` (Chapter 07): the layer that owns the data also
owns the time. It also means every record's timestamp comes from one code path, so the format cannot vary.

**`durationMs: Math.round(entry.durationMs)`** — the caller supplies `performance.now()` deltas
(Chapter 17), which are fractional. Rounding at the boundary means the stored record and the logged line
agree, and neither carries a spurious decimal. It is rounded *here* rather than in the caller, because the
caller's value may be needed at full precision elsewhere.

**`records.push(record)` before `logger.info(...)`.** Order matters in principle: if the logger threw — it
cannot, but the principle holds — the record would already be stored. **Write the durable copy first, then
the observable one.** The same discipline as recording an idempotency key after the task is in the map
(Chapter 07): persist, then announce.

**`logger.info("audit", record)` — the record *is* the log line.** No reformatting, no field selection. The
comment explains why both destinations exist:

> The same line goes to the audit trail *and* the log stream: one is the queryable record, the other is
> what an operator sees live.

Two audiences, one shape:

| Destination | Who reads it | How |
| :--- | :--- | :--- |
| `records[]` | the host, at the end of a session | `audit.entries()`, printed as a table |
| stderr log | an operator, a collector, a dashboard | `event="audit"`, greppable |

Because both come from the same object, they cannot disagree — the same single-source property as
`review`/`visible` in Chapter 15.

**`entries()` returns `[...records]`, a copy.** Same reasoning as `taskStore.list()`: a caller cannot
mutate the trail through the returned array. `records.pop()` on the result of `entries()` would have no
effect on the stored log.

**Why does this need a `logger` at all?** Because a record that only lives in an array dies with the
process — and the whole point of an audit trail is that it outlives the incident. The in-memory array
exists so the demo can print a table; the log line is what a real deployment would ship to a collector.
The constructor takes the logger as a parameter, so a test can pass a quiet one.

### Block 7 — what a production audit trail would add

The gap between this file and a production audit system is worth naming, because the *shape* here is right
even where the plumbing is missing.

**Durability.** The `records` array is in-process, so it is lost on exit. A real trail appends to
write-once storage, or ships each line to a collector with a retention policy. The log line already
exists, which is the important half.

**Tamper evidence.** Nothing here prevents a compromised process from writing a false record. A real trail
chains records by hash — each record includes the previous record's digest — so a gap or an edit is
detectable. That is a natural extension of `hashArgs`, and it is why hash-chaining is worth knowing about.

**Correlation IDs.** A record has no session or request id, so two calls from the same conversation cannot
be grouped. The logger's `child()` (Chapter 03) is the mechanism: `logger.child({ sessionId })` would put
the id on every line, and the audit record would need the same field.

**Retention and access control.** Who may read the trail, for how long, and under what legal basis, are
policy questions this codebase does not answer — and should not pretend to. What it does answer is the
hard part: **the arguments are not in it.**

---

## 16.4 Run / verify

The record table the host prints at the end of a run:

```bash
npm run host | sed -n '42,52p'
```

```text
10. audit      -> every decision, with hashed arguments
   time         tool           decision  outcome  argsHash          ms
   11:02:50.737 create_task    auto      ok       57036086e66b5396  33
   11:02:50.741 create_task    auto      ok       57036086e66b5396  2
   11:02:50.743 create_task    auto      ok       fe096691f37c3caa  2
   11:02:50.746 complete_task  auto      error    aa0c17ac393b495d  3
   11:02:50.749 complete_task  auto      ok       037c9214eef74cc3  3
   11:02:50.752 complete_task  auto      error    037c9214eef74cc3  2
   11:02:50.752 delete_task    confirm   denied   9e7e65453739bbc6  0
   11:02:50.758 delete_task    confirm   ok       9e7e65453739bbc6  5
```

Four things to read out of that table, and each one is a capability from Block 1:

1. **Rows 1 and 2 have the same `argsHash`** — `57036086e66b5396`. They were byte-identical requests
   (the idempotency replay from Chapter 07), and the hash proves it. **"Were these two calls
   identical?" — answered.**
2. **Rows 5 and 6 share `037c9214eef74cc3`** with two `error` outcomes — the second being the
   `CONFLICT` (Chapter 08). Same arguments, two attempts: **"Was this a retry?" — answered.**
3. **Rows 7 and 8 share `9e7e65453739bbc6`** with `denied` then `ok`. The *request* was identical; the
   *user's answer* changed (Chapter 17's scripted consent). The hash isolates the request from the
   decision, which is exactly what you need to ask "was this refused, then approved, or were they two
   different asks?"
4. **The `argsHash` column contains no readable argument anywhere.** The titles, the ids and the
   idempotency key are all absent — **"what did the user actually ask for?" — deliberately not
   answered.**

Note also `decision: confirm, outcome: denied` on row 7. That pair is the audit trail's record of a
*refused consent*, and it is the row an incident review would start from: the model proposed a
destructive action, the host asked, and the user said no.

The same records appear as structured log lines, because `record()` writes both:

```bash
npm run host 1>/dev/null 2>/tmp/audit.txt
grep '"event":"audit"' /tmp/audit.txt | head -2
```

```text
{"ts":"…","level":"info","event":"audit","host":"task-host","at":"…","actor":"user:demo","tool":"create_task","decision":"auto","outcome":"ok","argsHash":"57036086e66b5396","durationMs":41}
{"ts":"…","level":"info","event":"audit","host":"task-host","at":"…","actor":"user:demo","tool":"create_task","decision":"auto","outcome":"ok","argsHash":"57036086e66b5396","durationMs":2}
```

Note the `host: "task-host"` binding (from the logger's bindings, Chapter 03) and the absence of any
argument value. Every field is queryable: `event="audit" AND tool="delete_task" AND outcome="denied"`
is a valid log query — and the two lines above are identical except for `ts` and `durationMs`, which is
the replay, visible from outside the process.

Now verify the canonicalisation directly — the property that makes the digest meaningful:

```bash
npx tsx -e '
import { hashArgs } from "./src/host/audit.ts";

const a = { title: "Record MCP Video", idempotencyKey: "demo-request-42" };
const b = { idempotencyKey: "demo-request-42", title: "Record MCP Video" };  // same keys, other order
const c = { title: "Publish the notes" };                                    // different request
const d = { tags: ["a", "b"] };
const e = { tags: ["b", "a"] };                                              // array order matters

console.log("a:", hashArgs(a));
console.log("b:", hashArgs(b), "-> same as a?", hashArgs(a) === hashArgs(b));
console.log("c:", hashArgs(c), "-> same as a?", hashArgs(a) === hashArgs(c));
console.log("d:", hashArgs(d));
console.log("e:", hashArgs(e), "-> same as d?", hashArgs(d) === hashArgs(e));
'
```

```text
a: 57036086e66b5396
b: 57036086e66b5396 -> same as a? true
c: fe096691f37c3caa -> same as a? false
d: 5272f2592556de40
e: b4b48c25efc8fb66 -> same as d? false
```

Three properties confirmed in five lines:

1. **Key order does not matter.** `a` and `b` are the same request written two ways, and they hash
   identically — the `canonical` sort from Block 4, doing its job. **Without it, these two would have
   different digests and the replay in the demo would be invisible.**
2. **Different requests hash differently.** `c` is a different title, so a different digest — which is
   what makes the hash useful for counting distinct requests.
3. **Array order does matter.** `["a","b"]` and `["b","a"]` hash differently, because `canonical`
   preserves array order (Block 4). That is the deliberate asymmetry: sorted keys, unsorted arrays.

> The digests for `a` and `c` — `57036086e66b5396` and `fe096691f37c3caa` — match the demo's audit table
> **exactly**. That is not a coincidence: the demo's host hashed precisely those argument objects
> (Chapter 17), through this same function. It is also a useful check on a detail that is easy to get
> wrong — the demo's idempotency key is `demo-request-42`, and changing that string changes the first
> digest and breaks the match.

---

## 16.5 Checkpoint

1. **The audit trail answers the third clause** — "how do I prove it after the fact?" — which cannot be
   reconstructed later and must be recorded at the time.
2. **Arguments are hashed, never stored.** The digest correlates retries and detects replays; it cannot
   reconstruct the data, and it is useless to anyone who steals the log.
3. **`AuditEntry` has `args`; `AuditRecord` has `argsHash`.** The type system makes it impossible for a
   caller to write raw arguments into the trail — a stronger guarantee than a `redact()` call someone
   could forget.
4. **`canonical` sorts object keys but preserves array order.** Without the sort, two identical calls
   written in different key orders would hash differently and the replay would be invisible.
5. **The digest is a truncated SHA-256 (64 bits)**, chosen because the threat model includes someone
   testing a guess against the log.
6. **One record, two destinations.** The in-memory array is what the demo prints; the `event="audit"`
   log line is what a collector would ship — and because both come from the same object, they cannot
   disagree.
7. **`decision: "blocked"` is distinct from `"denied"`.** The first means the defence-in-depth re-check
   fired; the second means the policy filter worked. Collapsing them would hide an anomaly.
8. **`at` and `argsHash` are generated by the log, not accepted from the caller.** A caller-supplied
   timestamp is a caller-supplied lie.

---

**Back to:** [Implementation guide index](./README.md) · [Production Code README](../README.md)

**Previous:** [Chapter 15 — Host: Policy, Consent & Filtering](./15_Host_Policy.md)

**Next:** [Chapter 17 — Host: The Lifecycle](./17_Host_Client_Lifecycle.md)






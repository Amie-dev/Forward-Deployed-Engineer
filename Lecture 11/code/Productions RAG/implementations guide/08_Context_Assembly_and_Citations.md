# Chapter 08: Context Assembly and Citations

> **Chapter Goal:** Convert ranked chunks into a labelled evidence block that fits a token budget — and convert the model's `[n]` markers back into verifiable sources. This is the chapter where "grounded" stops being an adjective and becomes a data structure.

> **Lecture mapping:** Notes Chapter 06, sections on context assembly, citation markers, and the citation-validity guard.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/grounding/context.ts` | 108 | Label assignment, token budget, block rendering, block parsing. |
| `src/grounding/citations.ts` | 52 | Extract `[n]`, resolve against the label map, strip invented ids. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run demo | sed -n '28,48p'     # the assembled <documents> block
npm run ask -- "What is the refund window for apparel?"
#   [1] ok      refund-policy.md · Refund window (score 0.642)
npm run eval | tail -5
# [eval] citations      12/12
```

---

## 2. Assembling Evidence — `src/grounding/context.ts`

#### 📄 `src/grounding/context.ts`

```ts
import { countTokens } from '../ingest/chunker.js';
import { clip } from '../lib/text.js';
import type { Match } from '../types/rag.types.js';

/** One labelled piece of evidence, exactly as it appears inside `<documents>`. */
export interface ContextBlock {
  label: number;
  chunkId: string;
  source: string;
  section: string;
  text: string;
}

export interface AssembledContext {
  blocks: ContextBlock[];
  text: string;
  tokens: number;
}

/** Rough characters-per-token ratio, used only when a single chunk must be clipped. */
const CHARS_PER_TOKEN = 4;

/**
 * Turn matches into the evidence block of the prompt.
 *
 * Rules that matter more than they look:
 *   - Order is preserved: best match first, because attention is U-shaped and
 *     the last chunk is read almost as carefully as the first.
 *   - Labels are assigned here, not by the model, so a citation can be verified
 *     against a map instead of a guess.
 *   - The token budget is enforced before the call, not after the bill.
 */
export function assembleContext(matches: readonly Match[], maxTokens: number): AssembledContext {
  const blocks: ContextBlock[] = [];
  let tokens = 0;

  for (const match of matches) {
    const blockTokens = countTokens(match.text);

    if (tokens + blockTokens > maxTokens) {
      // Never send an empty evidence block: one clipped chunk beats a refusal.
      if (blocks.length === 0) {
        const text = clip(match.text, maxTokens * CHARS_PER_TOKEN);
        blocks.push({ label: 1, chunkId: match.id, source: match.source, section: match.section, text });
        tokens = countTokens(text);
      }
      break;
    }

    blocks.push({
      label: blocks.length + 1,
      chunkId: match.id,
      source: match.source,
      section: match.section,
      text: match.text,
    });
    tokens += blockTokens;
  }

  return { blocks, text: blocks.map(formatBlock).join('\n\n'), tokens };
}

/** `[1] refund-policy.md · Refund window` — the label the model must cite. */
export function formatBlock(block: ContextBlock): string {
  const heading = block.section ? `${block.source} · ${block.section}` : block.source;
  return `[${block.label}] ${heading}\n${block.text}`;
}

/**
 * Read the blocks back out of a rendered prompt.
 *
 * Only the offline extractive generator needs this; a real model reads the text.
 */
export function parseContextBlocks(text: string): ContextBlock[] {
  return text
    .split(/\n{2,}(?=\[\d+\]\s)/)
    .flatMap((raw) => {
      const match = /^\[(\d+)\]\s+([^\n]*)\n?([\s\S]*)$/.exec(raw.trim());
      if (!match) return [];

      const [source = 'unknown', section = ''] = match[2].split(' · ');
      return [
        {
          label: Number(match[1]),
          chunkId: '',
          source,
          section,
          text: match[3].trim(),
        },
      ];
    });
}
```

**Block by block:**

- **`ContextBlock`** — `label`, `chunkId`, `source`, `section`, `text`. `chunkId` is what makes the label verifiable: the citation can be resolved to a record, not just to a number.
- **`AssembledContext`** — blocks plus the rendered `text` plus the token count. The caller needs all three: the prompt needs text, the trace needs tokens, the label map needs blocks.
- **`CHARS_PER_TOKEN = 4`** — used in exactly one place: clipping a single oversized chunk. An approximation is acceptable because it only decides how much of *one* chunk to keep, and the next step measures the real token count.
- **`assembleContext(matches, maxTokens)`** — walks matches best-first and stops when the budget is exhausted:
  - `countTokens(match.text)` — real tokens, not an estimate.
  - `if (tokens + blockTokens > maxTokens)` — the budget check happens **before** the call, never after the bill.
  - **The first-block exception** — if even the best chunk does not fit, it is clipped rather than dropped. Sending zero evidence turns an answerable question into a refusal; sending a clipped best chunk usually still answers it.
  - `label: blocks.length + 1` — labels are positional and assigned here, so they are contiguous and predictable.
- **`formatBlock`** — `[1] refund-policy.md · Refund window` followed by the text. Every element of that line has a job: the number is the citation handle, the file tells the customer where it came from, the section tells them where to look.
- **`parseContextBlocks(text)`** — the inverse, used only by the offline extractive generator. It splits on blank lines followed by `[n] `, then splits the heading on ` · `.

### Why order is preserved

The notes describe the U-shaped attention curve: models read the beginning and the end of a long prompt far more reliably than the middle. Keeping the best chunk **first** means the most important evidence is in the high-attention zone, and the second-best is still near the end.

### Why labels are assigned before generation

If the model numbered its own sources, the numbers would be unverifiable: `[2]` could mean anything. Because the code assigns `[1..n]` and keeps `label → chunk` in a `Map`, a returned marker is either a key in that map or an invention. That is the entire citation guarantee, and it costs one `Map`.

### The budget, concretely

With `MAX_CONTEXT_TOKENS=1200` and an average chunk of ~50 tokens, all four chunks fit with room to spare. Raise `TOP_K` to 12 on the same corpus and the assembler stops early — which is the point: the budget is a ceiling on cost and on noise, enforced in code rather than in hope.

---

## 3. Verifying Citations — `src/grounding/citations.ts`

#### 📄 `src/grounding/citations.ts`

```ts
import type { Citation, Match } from '../types/rag.types.js';

const MARKER = /\[(\d+)\]/g;

/** All distinct `[n]` labels in an answer, in ascending order. */
export function extractCitationLabels(answer: string): number[] {
  const labels = new Set<number>();
  for (const match of answer.matchAll(MARKER)) labels.add(Number(match[1]));
  return [...labels].sort((left, right) => left - right);
}

/**
 * Resolve `[n]` against the chunks that were actually in the prompt.
 *
 * A label with no matching chunk is a fabricated source. That is the cheapest
 * hallucination detector in the whole system: no model call, no judgement, just
 * set membership.
 */
export function linkCitations(answer: string, labels: ReadonlyMap<number, Match>): Citation[] {
  return extractCitationLabels(answer).map((label) => {
    const match = labels.get(label);

    if (!match) {
      return { label, chunkId: '', source: '', section: '', score: 0, valid: false };
    }

    return {
      label,
      chunkId: match.id,
      source: match.source,
      section: match.section,
      score: match.score,
      valid: true,
    };
  });
}

/** Remove citations the model invented, so the customer never sees a fake source. */
export function stripInvalidMarkers(answer: string, labels: ReadonlyMap<number, Match>): string {
  return answer.replace(MARKER, (marker, raw: string) => (labels.has(Number(raw)) ? marker : ''));
}

export function countInvalid(citations: readonly Citation[]): number {
  return citations.filter((citation) => !citation.valid).length;
}
```

**Block by block:**

- **`MARKER = /\[(\d+)\]/g`** — one regex, one place. `[3]`, `[12]`, and `[3][7]` all parse.
- **`extractCitationLabels`** — `matchAll` + `Set`, so a repeated marker counts once, then sorted for stable output.
- **`linkCitations(answer, labels)`** — the core guard. For each label:
  - present in the map → a full `Citation` with `valid: true` and the real chunk id;
  - absent → `{ valid: false, chunkId: '', source: '' }`, kept in the array so the trace can count it.
- **`stripInvalidMarkers`** — removes invented ids from the text the customer sees. `[9]` becomes nothing; `[1]` survives. The answer stays readable and no longer claims a source that does not exist.
- **`countInvalid`** — the metric. A non-zero value on a real model means the prompt contract is leaking, and it should be alerted on rather than ignored.

### Worked example

The model returns:

```text
Apparel refunds are accepted within 3 days. [1] Shipping is free over $75. [3] See the full policy. [9]
```

Prompt labels were `1..3`. The linker produces:

| Label | In prompt? | Citation | Answer text after strip |
| :--- | :--- | :--- | :--- |
| 1 | yes | `refund-policy.md · Refund window`, valid | `[1]` kept |
| 3 | yes | `shipping-policy.md · Delivery options`, valid | `[3]` kept |
| 9 | no | `valid: false` | `[9]` removed |

Trace: `citations=2 invalidCitations=1`. Two of the three sentences are checkable; the third is not, and the system says so.

### What this does *not* catch

A **valid but wrong** citation: `[1]` exists, but the sentence it is attached to is not supported by chunk 1. Catching that needs entailment — a judge model or a natural-language-inference check — and it is deliberately out of scope here.

Two cheaper guards that are in scope for a production fork:

| Guard | Catches | Cost |
| :--- | :--- | :--- |
| Cited id ∈ retrieved ids (this file) | Fabricated sources | ~0 |
| Numbers in the answer appear in the context | 3 days → 30 days | ~0 |
| Entailment / judge | Subtle drift | one model call |

---

## 4. Verify the Chapter

```bash
npm run demo | sed -n '28,40p'
```

Expect blocks that look exactly like this:

```text
<documents>
[1] refund-policy.md · Refund window
Customers may request a refund within the following windows, measured from the delivery date:
…
[2] refund-policy.md · Exchanges
…
</documents>
```

Then:

```bash
npm run eval | tail -4
# [eval] citations      12/12
```

Every case in the golden set produced citations that resolved. The count is part of the pass/fail criteria, not a log line.

**Next:** [Chapter 09 — The Grounded Prompt](./09_The_Grounded_Prompt.md)

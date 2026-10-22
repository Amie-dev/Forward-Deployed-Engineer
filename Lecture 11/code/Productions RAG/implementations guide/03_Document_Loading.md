# Chapter 03: Document Loading

> **Chapter Goal:** Turn a folder of files into `SourceDocument[]` — deterministically, with the title intact and with a record of anything that could not be read. Nothing downstream can recover text that extraction lost.

> **Lecture mapping:** Notes Chapter 03, sections on extraction hazards, cleaning, and the coverage metric.

> **Files covered:**

| File | Lines | Purpose |
| :--- | ---: | :--- |
| `src/ingest/loader.ts` | 78 | Directory scan, PDF text extraction, normalisation, title detection. |
| `knowledge/refund-policy.md` | 45 | Corpus file 1 — refund windows, conditions, exclusions. |
| `knowledge/shipping-policy.md` | 37 | Corpus file 2 — delivery options, tracking, lost parcels. |
| `knowledge/warranty-policy.md` | 46 | Corpus file 3 — coverage, exclusions, claims. |

---

## 1. Commands

```bash
cd "Lecture 11/code"
npm run ingest
# [ingest] store=memory documents=3 chunks=19 tokens=870 31ms
# [ingest] index now holds 19 chunks
```

Point it at an empty folder to see the guard:

```bash
KNOWLEDGE_DIR=/tmp/empty npx tsx src/scripts/ingest.ts
# Error: No .md / .markdown / .txt / .pdf files in /tmp/empty. Refusing to build an empty index.
```

A build that fails is infinitely better than an index that is quietly empty.

---

## 2. The Loader — `src/ingest/loader.ts`

#### 📄 `src/ingest/loader.ts`

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { normaliseText } from '../lib/text.js';
import type { SourceDocument } from '../types/rag.types.js';

const SUPPORTED = new Set(['.md', '.markdown', '.txt', '.pdf']);

/**
 * Read every supported file in the knowledge folder, in a stable order.
 *
 * Order matters: it makes chunk indices, and therefore chunk ids, reproducible
 * across machines. That is what allows "re-ingest changed files only" later.
 */
export async function loadDocuments(directory: string): Promise<SourceDocument[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error(`Knowledge directory not found: ${directory}. Set KNOWLEDGE_DIR in .env.`);
    }
    throw error;
  });

  const files = entries
    .filter((entry) => entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(
      `No ${[...SUPPORTED].join(' / ')} files in ${directory}. Refusing to build an empty index.`,
    );
  }

  const documents = await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(directory, file);
      const raw = path.extname(file).toLowerCase() === '.pdf'
        ? await extractPdfText(filePath)
        : await readFile(filePath, 'utf8');
      const text = normaliseText(raw);

      return { source: file, title: detectTitle(text, file), text } satisfies SourceDocument;
    }),
  );

  return documents;
}

/**
 * PDFs have no structure left after extraction — only text. Scanned PDFs return
 * nothing at all, which is why the caller reports empty documents instead of
 * silently indexing them.
 */
async function extractPdfText(filePath: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const buffer = await readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });

  return Array.isArray(text) ? text.join('\n\n') : text;
}

/** First markdown H1 wins; otherwise the file name becomes the title. */
function detectTitle(text: string, file: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(text);
  if (heading) return heading[1];

  return path
    .basename(file, path.extname(file))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\p{Ll}/gu, (character) => character.toUpperCase());
}
```

**Block by block:**

- **`SUPPORTED`** — `.md`, `.markdown`, `.txt`, `.pdf`. Anything else (`.docx`, `.html`) is ignored rather than half-parsed; adding a format should mean adding an extractor, not a silent text dump.
- **`readdir(directory, { withFileTypes: true })`** — one syscall instead of `readdir` plus a `stat` per file.
- **The `ENOENT` branch** — a missing knowledge folder becomes an actionable message naming `KNOWLEDGE_DIR`, instead of `ENOENT: no such file or directory`.
- **`files.sort()`** — lexical order, deterministic across machines. This matters because chunk indices feed chunk ids: an unstable order would produce different ids for the same corpus and break idempotent re-ingestion.
- **`files.length === 0` → throw** — the empty-index guard. An empty index answers every question with a refusal, which *looks* like a working system and is the worst failure mode in RAG.
- **`Promise.all(files.map(...))`** — parallel reads. Extraction is I/O bound; there is no reason to serialise it.
- **`path.extname(file).toLowerCase() === '.pdf'`** — the PDF branch. Everything else is read as UTF-8.
- **`normaliseText(raw)`** — chapter 02's cleaner, applied once, at the boundary. Every later stage can assume normalised text.
- **`detectTitle(text, file)`** — first markdown `H1`, else the file name with `-`/`_` turned into spaces and each word capitalised. A `.txt` file still produces a useful title.
- **The return type** — `SourceDocument`, not `{ file, text }`. `source` is the published name; it is what a citation will show, so it is decided here and never re-derived.

### The PDF branch

```ts
const { extractText, getDocumentProxy } = await import('unpdf');
```

- **Dynamic import** — the extractor is only loaded when a PDF is actually present. A markdown-only corpus never pays for a PDF parser at boot.
- **`mergePages: true`** — one string instead of per-page arrays. Page numbers are lost, which is why a production version would split per page and store `page` in the metadata (the notes call this out: citations want a page).
- **`Array.isArray(text)`** — `unpdf` returns `string | string[]` depending on options; handling both is honest.
- **`pdf-parse` v1 is deliberately avoided** — it has a debug branch that runs when `module.parent` is undefined, which is exactly the state of an ESM import. `unpdf` is ESM-native.

### What the loader does *not* do

It does not decide whether a document was extracted well. A scanned PDF returns `''`, and the loader still returns the document. The caller (`RagService.ingest`) is the layer that drops empty documents and reports them in `skipped`, because that is where the coverage metric belongs.

---

## 3. The Corpus

The three files are small on purpose: 128 lines of policy text, 19 chunks. They are shaped like real support documentation — headings, bullet lists, numbers that matter — so every later stage has something honest to work with.

#### 📄 `knowledge/refund-policy.md`

```md
# Refund Policy

## Refund window

Customers may request a refund within the following windows, measured from the delivery date:

- Apparel (shirts, jackets, dresses): 3 days.
- Footwear (shoes, boots, sandals): 7 days.
- Electronics (phones, laptops, headphones): 14 days.

Requests opened after the window has closed are declined automatically by the returns system.

## Condition requirements

An item must be unused, unwashed and in its original packaging with all tags attached. Items that show signs of wear, odour or alteration are not eligible for a refund.

## How to start a refund

1. Open the order in the account area and select "Return or refund".
2. Choose a reason and upload a photo of the item.
3. Print the prepaid label and drop the parcel at any partner location.

Once the warehouse receives the parcel, inspection takes up to 2 business days.

## Refund timing

Approved refunds are issued to the original payment method within 5 to 7 business days. How long the money takes to reach the account depends on the bank, but it is never longer than 7 business days.

Store credit is issued within 24 hours and can be used immediately.

Shipping fees are refunded only when the return is caused by a wrong, damaged or defective item.

## Non-refundable items

The following are never refundable:

- Gift cards and digital vouchers.
- Underwear, swimwear and pierced jewellery.
- Items marked "final sale".
- Personalised or custom-made products.

## Exchanges

Exchanges follow the same window and condition rules as refunds. If the requested size is unavailable, the exchange is converted into a refund automatically.
```

#### 📄 `knowledge/shipping-policy.md`

```md
# Shipping Policy

## Delivery options

- Standard delivery: 3 to 5 business days, 4.99 USD, free for orders over 75 USD.
- Express delivery: 1 to 2 business days, 12.99 USD.
- Same-day delivery: available in selected cities for orders placed before 11:00 local time, 19.99 USD.

Orders placed after 18:00 or on public holidays are processed on the next business day.

## Order tracking

A tracking link is emailed as soon as the parcel leaves the warehouse. Tracking can take up to 12 hours to show the first scan. The order page always shows the current status, even when the carrier has not updated yet.

## Address changes

An address can be changed while the order status is "processing". Once the status is "shipped", the address is locked and the customer must contact the carrier directly.

## Split shipments

Orders containing items from different warehouses may arrive in separate parcels. Each parcel has its own tracking number and its own delivery estimate.

## Lost or delayed parcels

A parcel is considered lost when there is no tracking movement for 7 business days. At that point support can resend the order or issue a full refund, including shipping fees.

## International orders

We currently ship only inside the country where the order was placed. Cross-border delivery is not supported, so customs declarations, import duties and international return labels do not apply to our orders.

## Failed delivery attempts

The carrier makes 3 delivery attempts. After the third attempt the parcel returns to the warehouse and the order is refunded minus the original shipping fee.
```

#### 📄 `knowledge/warranty-policy.md`

```md
# Warranty Policy

## What the warranty covers

Every product carries a manufacturer warranty that covers defects in materials and workmanship under normal use:

- Electronics: 12 months from delivery.
- Footwear: 24 months for manufacturing defects such as sole separation or stitching failure.
- Accessories: 6 months.

The warranty is tied to the order number and does not require registration.

## What the warranty does not cover

- Accidental damage, drops and cracked screens.
- Water or liquid damage on items not advertised as water resistant.
- Normal wear such as faded colours, stretched elastic or worn soles.
- Repairs performed by an unauthorised service centre.
- Products bought from third-party sellers.

## How to make a claim

1. Contact support with the order number and a description of the fault.
2. Attach photos or a short video that shows the defect.
3. The assessment takes up to 10 business days after the item reaches the service centre.

## Repair, replace or refund

The service centre chooses the fastest option: repair first, replacement when repair is not possible, refund when neither is available. Replacement units inherit the remaining warranty of the original item, they do not restart the warranty period.

## Warranty and refunds are different

A refund returns the money inside the refund window. A warranty claim covers the whole warranty period and is handled as a separate process. An item can be outside the return period and still be covered by the warranty.

## Extended warranty

Extended coverage can be purchased within 30 days of delivery. It adds 12 months to the manufacturer warranty and must be bought for the same order it covers.
```

**Why the corpus is written this way:**

- **Headings everywhere.** Each `##` becomes a section, and every chunk inherits it. That is what makes a citation read `refund-policy.md · Refund window` instead of `refund-policy.md · chunk 2`.
- **Numbers in prose.** `3 days`, `5 to 7 business days`, `12.99`, `75` — the evaluation checks that these survive retrieval *and* generation. A system that paraphrases "3 days" into "a few days" is broken even when it sounds right.
- **Overlapping vocabulary, distinct facts.** "Refund" appears in all three documents. A system that only matches the word "refund" cannot tell the refund window from the warranty process — which is exactly the difficulty real support corpora have.
- **Deliberate gaps.** No student discount, no Bitcoin, no international shipping. Two golden-set questions ask for those facts, and the only correct answer is the refusal sentence.
- **A synonym clause** — `Footwear (shoes, boots, sandals)` — so an offline lexical embedder can still answer "return shoes". With a real model this line is redundant; with the mock it is what makes the demo honest rather than lucky.

---

## 4. Failure Modes and What They Look Like

| Symptom | Cause | Where you see it |
| :--- | :--- | :--- |
| `documents=3 chunks=0` | Every file extracted to empty text (scanned PDF) | `ingest()` throws instead of writing an empty index |
| `skipped: ["scan.pdf"]` | That one file produced no text | `IngestReport.skipped`, printed by `npm run ingest` |
| Titles are file names | No `# H1` in the document | `detectTitle` fallback; harmless but less readable in citations |
| Duplicate chunks after editing a file | Old chunks were never deleted | Prevented in chapter 12 (`deleteBySource` before upsert) |
| Chunk order changes between runs | Unsorted `readdir` | Prevented by `files.sort()` |

**Next:** [Chapter 04 — Chunking](./04_Chunking.md)

# Chapter 06 — Cost Guard: The Image Token Budget

> **Goal of this chapter:** turn Chapter 04's arithmetic into an invoice. This is the smallest
> file in the project and the one most likely to save the most money, because Chapter 08's rule
> is *compute the budget before you build the demo* — not after the bill.
>
> **Lecture chapter:** [08 — Production: Cost, Security and Evaluation](../../../notes/08_Production_Multimodal_Systems_Cost_Security_And_Evaluation.md), §8.2.

---

## 6.1 File details

| | |
|---|---|
| **Path** | `src/services/costService.js` |
| **Purpose** | estimate an image's token cost, decide whether it fits the budget, price a conversation |
| **Imports** | `config` (`patchSize`, `maxImageTokens`) |
| **Exports** | `estimateImageTokens`, `guardImage`, `conversationCost` |
| **Who imports it** | `chatService` (`guardImage`), `demo.js`, `app.test.js` |
| **Depends on** | `src/config/config.js` |

**Commands**

```bash
cd "Lecture 16/code/Basic Code"
node -e "import('./src/services/costService.js').then(m => { for (const d of [{width:512,height:512},{width:1024,height:1024},{width:1920,height:1080},{width:4000,height:3000}]) console.log(d.width+'x'+d.height, m.guardImage(d)); })"
```

---

## 6.2 Full file

**Path:** `src/services/costService.js`

```js
// Lecture 16 · Chapter 08.2 — images are expensive tokens.
//
// Everything in Chapter 04's arithmetic becomes money here, and the scaling law is
// the one to remember: cost grows with AREA, not with the number of files.
import { config } from '../config/config.js';

// The lecture's formula:  image tokens ≈ (width / patch) × (height / patch).
//   512  x 512   @16 -> ~1,024
//   1024 x 1024  @16 -> ~4,096
//   1920 x 1080  @16 -> ~8,160   ← the board's cat.jpg
export function estimateImageTokens({ width, height }, patchSize = config.patchSize) {
  return Math.ceil(width / patchSize) * Math.ceil(height / patchSize);
}

// The pre-send guard: decide BEFORE spending money.
//   send              — inside budget, pass the image through
//   crop-or-downscale — over budget, the caller must shrink the region of interest
export function guardImage(dimensions, budget = config.maxImageTokens) {
  const tokens = estimateImageTokens(dimensions);
  if (tokens > budget) {
    return {
      action: 'crop-or-downscale',
      tokens,
      budget,
      reason: `estimated ${tokens} image tokens exceeds the ${budget}-token budget`,
    };
  }
  return { action: 'send', tokens, budget };
}

// Chapter 07.6 / 08.2 — the conversation cost trap.
// An image in history is re-sent every turn, so the real cost is tokens × turns.
// One 1,000-token image over 10 turns is 10,000 tokens, not 1,000.
export function conversationCost(tokensPerImage, turns) {
  return tokensPerImage * turns;
}
```

---

## 6.3 Block-by-block explanation

**Block 1 — `estimateImageTokens`: the lecture's formula**

```js
export function estimateImageTokens({ width, height }, patchSize = config.patchSize) {
  return Math.ceil(width / patchSize) * Math.ceil(height / patchSize);
}
```

- **What it does:** reproduces Chapter 08.2's formula exactly —
  `image tokens ≈ (width / patch) × (height / patch)`.
- It is **the same arithmetic as `toPatches`** in Chapter 04, and that is not a coincidence:
  **the number of patches *is* the number of visual tokens.** Chapter 04 called it "how the
  model reads the image"; Chapter 08 calls the same integer "what you pay". One number, two
  chapters.
- `Math.ceil` again, for the same reason as Chapter 04: `1080 / 16 = 67.5`, and dropping the
  half-row would under-report the cost. Under-reporting cost is the failure mode that matters.
- The comment carries the lecture's table, so the scaling law is visible at the call site:
  `512² → ~1,024`, `1024² → ~4,096`, `1920×1080 → ~8,160`. Doubling the *side* quadruples the
  cost, because area is quadratic.
- `patchSize` is a default parameter so a test or a demo can override it, but `config.patchSize`
  is the real value — and Chapter 04.8 says you never tune it per request anyway.

**Block 2 — `guardImage`: decide before you spend**

```js
export function guardImage(dimensions, budget = config.maxImageTokens) {
  const tokens = estimateImageTokens(dimensions);
  if (tokens > budget) {
    return {
      action: 'crop-or-downscale',
      tokens,
      budget,
      reason: `estimated ${tokens} image tokens exceeds the ${budget}-token budget`,
    };
  }
  return { action: 'send', tokens, budget };
}
```

- **What it does:** returns a *decision object*, not a boolean. The caller gets the verdict, the
  measurement, and the reason — which is what lets `chatService` build a helpful `413` message
  instead of a bare "too large".
- **Why a decision object and not `true`/`false`.** Chapter 07.4's advice is to make image
  quality *"an explicit, measured input to your pipeline and branch on it"*. A boolean throws
  the measurement away; an object keeps it. The same shape would carry a third action
  (`reject-blurry`, say) without changing any caller.
- `action: 'send'` / `'crop-or-downscale'` are **verbs, not states**, so the caller has a next
  step rather than a status. `crop-or-downscale` is deliberately not `reject`: Chapter 08.2's
  mitigation list says the answer to an expensive image is to send *less of it*, and Chapter
  07.8 confirms cropping to the region of interest is usually the single biggest win.
- **What this function deliberately does not do:** it does not resize anything. There is no
  image library in this project, and the crop itself is a product decision — which region
  matters? Reporting the decision and leaving the policy to the caller is the honest boundary.

**Block 3 — `conversationCost`: the trap that multiplies**

```js
export function conversationCost(tokensPerImage, turns) {
  return tokensPerImage * turns;
}
```

- **What it does:** multiplies a single image's token count by the number of turns in the
  conversation. One 1,000-token image over 10 turns is **10,000 tokens** — not 1,000.
- **Why this deserves its own function** rather than being inlined. Chapter 08.2's cost trap is
  the least intuitive thing in the lecture: cost is *per image per turn*, because the image
  stays in the conversation history and is **re-sent** with every request (Chapter 07.6).
  Naming it makes it visible, and the demo prints it as a headline number.
- It is deliberately trivial arithmetic. Its value is that it is *called* — so the concept is
  in the codebase and can be pointed at, rather than living only in a paragraph.

---

## 6.4 Run / verify

```bash
cd "Lecture 16/code/Basic Code"
node -e "import('./src/services/costService.js').then(m => { for (const d of [{width:512,height:512},{width:1024,height:1024},{width:1920,height:1080},{width:4000,height:3000}]) console.log(d.width+'x'+d.height, m.guardImage(d)); })"
```

Expected (verified):

```text
512x512    { action: 'send', tokens: 1024, budget: 8160 }
1024x1024  { action: 'send', tokens: 4096, budget: 8160 }
1920x1080  { action: 'send', tokens: 8160, budget: 8160 }
4000x3000  { action: 'crop-or-downscale', tokens: 47000, budget: 8160, reason: 'estimated 47000 image tokens exceeds the 8160-token budget' }
```

In `npm run demo`, section 6:

```text
6. COST GUARD (Chapter 08) — images are expensive tokens
   image tokens : 8160 = (1920/16) x (1080/16)
   budget       : 8160
   decision     : send
   12 MP image  : crop-or-downscale (47000 tokens)
   conversation : 81600 tokens for ONE image over 10 turns
```

Note the default budget `8160` is *exactly* the board's `cat.jpg` — it passes by zero margin.
That is intentional: the lecture's own image is the boundary case, and the 12 MP photo on the
next line is what happens past it.

**The budget rule from Chapter 08.2, as a formula to run before you build:**

```text
image_tokens × turns × users × days
```

`8,160 × 10 × 1,000 × 30 ≈ 2.4 billion` image tokens per month. That number is usually the
deciding architectural fact — which is why this file exists *before* the feature does.

---

## 6.5 Checkpoint

1. **Why is `estimateImageTokens` the same arithmetic as `toPatches`?** → because the number of
   patches **is** the number of visual tokens. Chapter 04's "how the model reads it" and
   Chapter 08's "what you pay" are one integer.
2. **Why does `guardImage` return `crop-or-downscale` rather than `reject`?** → because the fix
   for an expensive image is to send less of it (crop to the region of interest), not to refuse
   the user.
3. **Why is cost per image *per turn*?** → the image stays in conversation history and is
   re-sent with every request (Chapter 07.6).

**Next:** [Chapter 07 — Upload Middleware: An Untrusted Image](./07_Upload_Middleware_Validating_Untrusted_Images.md)


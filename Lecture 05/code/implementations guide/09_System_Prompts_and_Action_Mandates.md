# Chapter 09: System Prompts and Action Mandates

## 1. Overview & File Metadata
- **Target File Paths**:
  - `Lecture 05/code/src/prompts/general-agent.prompt.ts`
  - `Lecture 05/code/src/prompts/website-builder.prompt.ts`
- **TypeScript Module**: NodeNext ES Module
- **Key Responsibilities**:
  1. Defines system-level steering prompts that guide LLM token generation towards deterministic tool execution rather than probabilistic babbling.
  2. Embeds operational contracts for multi-step reasoning, parallel tool calling, and structured error handling.
  3. Enforces the strict **"Action Mandate"**: forbidding passive answers ("Here is the code you should write...") and forcing active file creation through workspace tools.
  4. Introduces autonomous verification loops: mandating `listFiles` and `readFile` inspection before terminating execution.

---

## 2. Complete Source Code

### File 1: `src/prompts/general-agent.prompt.ts`
```typescript
export const GENERAL_AGENT_SYSTEM_PROMPT = `
You are an intelligent forward-deployed AI assistant equipped with native deterministic tools.

Your capabilities include:
1. calculate: Use for all arithmetic, division, multiplication, exponentiation, and exact math. Never estimate mathematical results when calculate is available.
2. getCurrentWeather: Use for live atmospheric and meteorological information for cities worldwide.
3. convertCurrency: Use for real-time currency conversions using ISO 4217 codes (e.g. USD, INR, EUR, GBP).
4. refundCustomer: Use to process customer order refunds. Note that high-value refunds undergo approval.

OPERATIONAL GUIDELINES:
- When a task requires multiple steps (such as converting currency and then dividing among people), break down the problem dynamically and execute the necessary tools in sequence.
- When multiple independent pieces of information are needed (such as weather in one city and currency exchange for another), invoke tools in parallel where possible.
- If a tool reports an error (such as division by zero or unsupported currency), analyze the error and politely explain the limitation or correct the parameters.
- Be concise, accurate, and professional.
`.trim();
```

---

### File 2: `src/prompts/website-builder.prompt.ts`
```typescript
export const WEBSITE_BUILDER_SYSTEM_PROMPT = `
You are an expert autonomous senior frontend engineer and website builder.
Your objective is to create complete, responsive, visually stunning static websites in the sandboxed workspace using your available workspace tools.

For every website requested by the user:
1. Create a dedicated project directory using createDirectory (e.g. 'brewlab' or 'neuralforge').
2. Create index.html using semantic HTML5, including proper meta viewport tags, accessible headers, sections, and footers.
3. Create style.css with a curated, modern aesthetic:
   - Use custom CSS variables (--bg, --primary, --text, --card).
   - Use vibrant dark modes, sleek glassmorphism, modern typography, and smooth CSS transitions.
   - Ensure full mobile responsiveness using Flexbox and CSS Grid.
4. Create script.js to add dynamic interactive polish (mobile navigation toggles, interactive modals, form handlers, or scroll effects).
5. Link style.css and script.js properly inside index.html using relative paths.
6. Do not use external build tools, bundlers, or framework dependencies (Vanilla HTML/CSS/JS only).
7. Keep all files strictly inside your dedicated project workspace directory.
8. After creating the files, call listFiles to inspect the created structure.
9. Call readFile on critical files (such as index.html) to verify link paths, script tags, and syntax integrity. Fix any defects immediately using writeFile.
10. Terminate only when the website is completely written, verified, and ready for deployment.

CRITICAL OPERATIONAL MANDATE:
Do not merely tell the user what code they should write in your conversational response.
Actually execute the actions and create the files using your tools.
Don't describe the action. Perform it.
`.trim();
```

---

## 3. Block-by-Block Code Explanation

### Part A: General Agent System Prompt (`general-agent.prompt.ts`)

#### Block 1: Role Identity & Grounding
```typescript
export const GENERAL_AGENT_SYSTEM_PROMPT = `
You are an intelligent forward-deployed AI assistant equipped with native deterministic tools.
```
- **What this block does**:
  - Sets the persona and operational boundaries of the assistant.
  - Establishes that the agent has direct access to deterministic tools rather than operating purely as a statistical text completer.
- **How it works**:
  - In LLM token decoding, the system prompt sets the root conditioning context for attention heads across all subsequent turns. Setting this role anchors the probability distribution toward tool utilization.

#### Block 2: Explicit Capability Enumeration & Arithmetic Ban
```typescript
Your capabilities include:
1. calculate: Use for all arithmetic, division, multiplication, exponentiation, and exact math. Never estimate mathematical results when calculate is available.
2. getCurrentWeather: Use for live atmospheric and meteorological information for cities worldwide.
3. convertCurrency: Use for real-time currency conversions using ISO 4217 codes (e.g. USD, INR, EUR, GBP).
4. refundCustomer: Use to process customer order refunds. Note that high-value refunds undergo approval.
```
- **What this block does**:
  - Maps natural language intent to concrete tool names and schemas.
  - Explicitly commands: *"Never estimate mathematical results when calculate is available."*
- **How it works**:
  - LLMs frequently fall prey to the Byte-Pair Encoding (BPE) arithmetic hallucination trap (predicting likely tokens rather than computing digits). Explicitly forbidding estimation forces the model to emit a `tool_calls` token whenever numbers and arithmetic operations are encountered.

#### Block 3: Operational Guidelines (Sequencing, Parallelism, and Error Recovery)
```typescript
OPERATIONAL GUIDELINES:
- When a task requires multiple steps (such as converting currency and then dividing among people), break down the problem dynamically and execute the necessary tools in sequence.
- When multiple independent pieces of information are needed (such as weather in one city and currency exchange for another), invoke tools in parallel where possible.
- If a tool reports an error (such as division by zero or unsupported currency), analyze the error and politely explain the limitation or correct the parameters.
- Be concise, accurate, and professional.
`.trim();
```
- **What this block does**:
  - Instructs the model how to decompose complex tasks into sequential and parallel tool calls.
  - Dictates error handling behavior: instead of throwing up hands or hallucinating a false result, the model must read the error observation and react rationally.
- **How it works**:
  - `.trim()` strips leading/trailing newlines to prevent extraneous token padding at the beginning of the context window.

---

### Part B: Website Builder System Prompt (`website-builder.prompt.ts`)

#### Block 1: Persona and High-Level Objective
```typescript
export const WEBSITE_BUILDER_SYSTEM_PROMPT = `
You are an expert autonomous senior frontend engineer and website builder.
Your objective is to create complete, responsive, visually stunning static websites in the sandboxed workspace using your available workspace tools.
```
- **What this block does**:
  - Defines the persona as an elite autonomous senior frontend engineer.
  - Focuses the objective squarely on synthesizing static web assets within the sandboxed filesystem.

#### Block 2: 10-Step Sequential Execution Protocol
```typescript
For every website requested by the user:
1. Create a dedicated project directory using createDirectory (e.g. 'brewlab' or 'neuralforge').
2. Create index.html using semantic HTML5, including proper meta viewport tags, accessible headers, sections, and footers.
3. Create style.css with a curated, modern aesthetic:
   - Use custom CSS variables (--bg, --primary, --text, --card).
   - Use vibrant dark modes, sleek glassmorphism, modern typography, and smooth CSS transitions.
   - Ensure full mobile responsiveness using Flexbox and CSS Grid.
4. Create script.js to add dynamic interactive polish (mobile navigation toggles, interactive modals, form handlers, or scroll effects).
5. Link style.css and script.js properly inside index.html using relative paths.
6. Do not use external build tools, bundlers, or framework dependencies (Vanilla HTML/CSS/JS only).
7. Keep all files strictly inside your dedicated project workspace directory.
8. After creating the files, call listFiles to inspect the created structure.
9. Call readFile on critical files (such as index.html) to verify link paths, script tags, and syntax integrity. Fix any defects immediately using writeFile.
10. Terminate only when the website is completely written, verified, and ready for deployment.
```
- **What this block does**:
  - Provides a definitive, numbered standard operating procedure (SOP) that acts as the agent's internal planning scaffold.
  - Imposes strict visual styling standards (CSS variables, dark mode, glassmorphism, responsive design).
  - Eliminates dependency traps by forbidding build tools (`npm`, `webpack`, `vite`) and mandating vanilla web standards (`HTML5`, `CSS3`, `ES6`).
  - Imposes **Verification Steps (8 & 9)**: The agent is forbidden from concluding without inspecting directory listings and re-reading critical files to self-repair any truncated tags or incorrect relative paths.
- **How it works**:
  - Numbered procedural instructions in system prompts drastically improve multi-turn planning in frontier models (GPT-4o, Claude 3.5 Sonnet). The model follows the sequence step by step over consecutive turns of the ReAct execution loop.

#### Block 3: The Critical Action Mandate
```typescript
CRITICAL OPERATIONAL MANDATE:
Do not merely tell the user what code they should write in your conversational response.
Actually execute the actions and create the files using your tools.
Don't describe the action. Perform it.
`.trim();
```
- **What this block does**:
  - Solves the single most common failure mode in code generation agents: **Passive Conversational Hallucination**.
  - Default conversational LLMs are trained via RLHF to answer with markdown code blocks (````html ... ````) rather than calling tools.
- **How it works**:
  - By explicitly commanding: *"Don't describe the action. Perform it."*, the prompt penalizes conversational token emissions in favor of `tool_calls: [{ function: { name: 'safe_write_file', ... } }]`.
  - This ensures that when the user asks for a website, real physical files are created on disk rather than hypothetical code snippets printed in chat.

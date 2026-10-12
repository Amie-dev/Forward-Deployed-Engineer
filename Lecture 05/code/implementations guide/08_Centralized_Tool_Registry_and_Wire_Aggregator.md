# Chapter 08: Centralized Tool Registry and Wire Aggregator

## 1. Overview & File Metadata
- **Target File Path**: `Lecture 05/code/src/tools/registry.ts`
- **TypeScript Module**: NodeNext ES Module (`import ... from './...js'`)
- **Key Responsibilities**:
  1. Implements the Registry Pattern (`ToolRegistry`) to decouple agent orchestration from individual tool declarations.
  2. Aggregates heterogeneous tools (`calculator`, `weather`, `currency`, `refund`, `workspace`) into a keyed in-memory lookup map.
  3. Transforms internal `Tool` definitions into the exact wire-level `OpenAI.Chat.ChatCompletionTool[]` JSON Schema format required by the OpenAI Chat Completions API.
  4. Exports singleton instances (`defaultWorkspaceTools`, `defaultToolRegistry`) for zero-boilerplate consumption in REST routes and CLI scripts.

### Terminal Verification
To test TypeScript compilation of the registry:
```bash
npx tsc --noEmit
```

---

## 2. Complete Source Code

```typescript
import OpenAI from 'openai';
import { Tool } from '../types/tool.types.js';
import { calculatorTool } from './calculator.tool.js';
import { weatherTool } from './weather.tool.js';
import { currencyTool } from './currency.tool.js';
import { refundTool } from './refund.tool.js';
import { WorkspaceTools } from './workspace.tools.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(initialTools: Tool[] = []) {
    for (const tool of initialTools) {
      this.register(tool);
    }
  }

  public register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public list(): Tool[] {
    return Array.from(this.tools.values());
  }

  public getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Formats tools into standard OpenAI ChatCompletionTool JSON Schema wire payload
   */
  public getWireDefinitions(): OpenAI.Chat.ChatCompletionTool[] {
    return this.list().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }
}

// Global default workspace tools instance
export const defaultWorkspaceTools = new WorkspaceTools();

// Global default tool registry containing conversational + workspace tools
export const defaultToolRegistry = new ToolRegistry([
  calculatorTool,
  weatherTool,
  currencyTool,
  refundTool,
  ...defaultWorkspaceTools.getAllTools()
]);
```

---

## 3. Block-by-Block Code Explanation

### Block 1: Imports and Dependency Resolution
```typescript
import OpenAI from 'openai';
import { Tool } from '../types/tool.types.js';
import { calculatorTool } from './calculator.tool.js';
import { weatherTool } from './weather.tool.js';
import { currencyTool } from './currency.tool.js';
import { refundTool } from './refund.tool.js';
import { WorkspaceTools } from './workspace.tools.js';
```
- **What this block does**:
  - Imports the official `OpenAI` namespace for the `OpenAI.Chat.ChatCompletionTool` wire-format type.
  - Imports the enterprise contract `Tool` from `../types/tool.types.js`.
  - Imports all discrete operational tools: arithmetic (`calculatorTool`), meteorological telemetry (`weatherTool`), financial FX conversion (`currencyTool`), high-impact financial actuation (`refundTool`), and the sandboxed workspace actuator class (`WorkspaceTools`).
- **How it works**:
  - Employs strict `.js` import specifiers adhering to NodeNext module resolution. Notice that while `calculatorTool`, `weatherTool`, `currencyTool`, and `refundTool` are pre-instantiated singleton object exports, `WorkspaceTools` is imported as a class so custom base directories can be injected if needed.

---

### Block 2: The `ToolRegistry` Class & State Store
```typescript
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(initialTools: Tool[] = []) {
    for (const tool of initialTools) {
      this.register(tool);
    }
  }
```
- **What this block does**:
  - Encapsulates tool management behind an object-oriented registry interface.
  - Maintains private state in an ES6 `Map<string, Tool>`, keyed by tool identifier (e.g., `'calculator'`, `'safe_write_file'`).
  - Accepts an optional array of `initialTools` in the constructor to allow pre-populating tools during instantiation.
- **How it works**:
  - Using a `Map` provides $O(1)$ lookups during the agent's ReAct execution loop when an LLM emits `tool_calls: [{ function: { name: 'calculator' } }]`.
  - Avoids global mutation by keeping the map private and exposing controlled registration and retrieval methods.

---

### Block 3: Registration, Retrieval, and Inspection Methods
```typescript
  public register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public list(): Tool[] {
    return Array.from(this.tools.values());
  }

  public getNames(): string[] {
    return Array.from(this.tools.keys());
  }
```
- **What this block does**:
  - `register(tool)`: Adds or overrides a tool definition. Emits a diagnostic warning if a tool name collisions occurs.
  - `get(name)`: Retrieves the tool definition and its executable handler by string key in $O(1)$ time.
  - `has(name)`: Fast existence check used by dispatchers before invoking a tool.
  - `list()`: Materializes an array of all registered `Tool` objects for iteration.
  - `getNames()`: Returns all registered tool names, useful for logging, debugging, and system prompt dynamic catalog generation.
- **How it works**:
  - Ensures type-safe access throughout the agent lifecycle. If an LLM hallucinates an invalid tool name (e.g., `execute_sql_query`), `this.get('execute_sql_query')` immediately yields `undefined`, allowing the engine to return a graceful `"Tool execute_sql_query does not exist"` observation to the model rather than crashing the process.

---

### Block 4: The OpenAI Wire Schema Transformer (`getWireDefinitions`)
```typescript
  /**
   * Formats tools into standard OpenAI ChatCompletionTool JSON Schema wire payload
   */
  public getWireDefinitions(): OpenAI.Chat.ChatCompletionTool[] {
    return this.list().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }
}
```
- **What this block does**:
  - Translates internal registry tools into the exact JSON wire payload expected by the OpenAI Chat Completions API (`POST https://api.openai.com/v1/chat/completions`).
- **How it works**:
  - It iterates over `this.list()` and wraps each tool's metadata in `{ type: 'function', function: { name, description, parameters } }`.
  - The `'function' as const` assertion guarantees that TypeScript preserves the literal union type `'function'`, matching `OpenAI.Chat.ChatCompletionTool`.
  - When passed directly to `openai.chat.completions.create({ tools: registry.getWireDefinitions() })`, the OpenAI gateway parses these JSON Schemas and passes them to the LLM's constrained decoding grammar.

---

### Block 5: Global Singletons and Default Export
```typescript
// Global default workspace tools instance
export const defaultWorkspaceTools = new WorkspaceTools();

// Global default tool registry containing conversational + workspace tools
export const defaultToolRegistry = new ToolRegistry([
  calculatorTool,
  weatherTool,
  currencyTool,
  refundTool,
  ...defaultWorkspaceTools.getAllTools()
]);
```
- **What this block does**:
  - Instantiates `defaultWorkspaceTools` bound to the default `./workspace` sandbox.
  - Constructs `defaultToolRegistry` containing the full suite of 8 enterprise tools:
    1. `calculator`
    2. `get_current_weather`
    3. `convert_currency`
    4. `process_refund`
    5. `create_directory`
    6. `safe_write_file`
    7. `safe_read_file`
    8. `list_files`
- **How it works**:
  - Uses the ES6 spread operator `...defaultWorkspaceTools.getAllTools()` to flatten the filesystem actuators into the registry array.
  - Any module or script can now import `{ defaultToolRegistry }` and execute multi-turn agents with zero boilerplate setup.

# Chapter 06: Sandboxed Workspace Filesystem Actuator

> **Chapter Goal:** Implement the sandboxed file system actuator (`WorkspaceTools`), enforce strict path traversal defenses and symlink resolution (`fs.realpath`), and implement the 4 core workspace tools: `createDirectory`, `writeFile`, `readFile`, and `listFiles`.

---

## 6.1 File Details & Purpose

| File | Target Path | Operational Purpose |
| :--- | :--- | :--- |
| **`workspace.tools.ts`** | `Lecture 05/code/src/tools/workspace.tools.ts` | Provides sandboxed file system actuation and closed-loop environmental observation for the Website Builder Agent. Encapsulates directory creation, atomic writing, reading, and listing while enforcing strict security boundaries. |

### Terminal Commands
```bash
# Verify workspace root directory
ls -la "Lecture 05/code/generated-sites"
```

---

## 6.2 Full Code File: `src/tools/workspace.tools.ts`

```typescript
import * as path from 'path';
import * as fs from 'fs/promises';
import { z } from 'zod';
import { Tool } from '../types/tool.types.js';

export class WorkspaceTools {
  private readonly workspaceRoot: string;

  constructor(workspaceDir: string = 'generated-sites') {
    this.workspaceRoot = path.resolve(process.cwd(), workspaceDir);
  }

  /**
   * Initializes the workspace directory on disk
   */
  public async init(): Promise<void> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Hardened Path Resolver: Prevents path traversal, directory escapes, and symlink exploits
   */
  public async safePath(userPath: string): Promise<string> {
    // 1. Resolve relative path against workspace root
    const resolvedPath = path.resolve(this.workspaceRoot, userPath);

    // 2. Lexical boundary containment check
    if (!resolvedPath.startsWith(this.workspaceRoot)) {
      throw new Error(
        `Security Violation: Path '${userPath}' attempts to escape sandboxed workspace (${this.workspaceRoot}).`
      );
    }

    // 3. Symlink canonicalization check if path already exists on disk
    try {
      const realPath = await fs.realpath(resolvedPath);
      if (!realPath.startsWith(this.workspaceRoot)) {
        throw new Error(
          `Security Violation: Symlink at '${userPath}' resolves to target outside workspace.`
        );
      }
      return realPath;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // Path does not exist yet (e.g. creating new file); lexical containment check is sufficient
        return resolvedPath;
      }
      throw err;
    }
  }

  // ==========================================
  // TOOL 1: CREATE DIRECTORY
  // ==========================================
  public getCreateDirectoryTool(): Tool<{ path: string }, string> {
    const schema = z.object({
      path: z.string().min(1).describe('Relative directory path to create inside the workspace')
    });

    return {
      name: 'createDirectory',
      description:
        'Creates a project directory or subdirectory inside the sandboxed website workspace. Use this when scaffolding a new project.',
      tier: 'scoped_mutate',
      argsSchema: schema,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of directory to create'
          }
        },
        required: ['path']
      },
      execute: async ({ path: dirPath }) => {
        const target = await this.safePath(dirPath);
        await fs.mkdir(target, { recursive: true });
        return `Successfully created directory: ${dirPath}`;
      }
    };
  }

  // ==========================================
  // TOOL 2: WRITE FILE
  // ==========================================
  public getWriteFileTool(): Tool<{ path: string; content: string }, string> {
    const schema = z.object({
      path: z.string().min(1).describe('Relative file path to write (e.g., brewlab/index.html)'),
      content: z.string().describe('Complete text content to write into the file')
    });

    return {
      name: 'writeFile',
      description:
        'Creates or overwrites a text file inside the workspace. Use this for index.html, style.css, and script.js files.',
      tier: 'scoped_mutate',
      argsSchema: schema,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path (e.g., brewlab/index.html)'
          },
          content: {
            type: 'string',
            description: 'Complete contents of the file'
          }
        },
        required: ['path', 'content']
      },
      execute: async ({ path: filePath, content }) => {
        // Guard against massive payload DoS (5MB limit)
        if (content.length > 5 * 1024 * 1024) {
          throw new Error('Payload size exceeds 5MB limit.');
        }

        const target = await this.safePath(filePath);

        // Ensure parent directory exists automatically
        await fs.mkdir(path.dirname(target), { recursive: true });

        // Write file with strict UTF-8 encoding
        await fs.writeFile(target, content, 'utf8');
        return `Successfully wrote ${content.length} characters to: ${filePath}`;
      }
    };
  }

  // ==========================================
  // TOOL 3: READ FILE (ENVIRONMENTAL OBSERVATION)
  // ==========================================
  public getReadFileTool(): Tool<{ path: string }, string> {
    const schema = z.object({
      path: z.string().min(1).describe('Relative file path to inspect')
    });

    return {
      name: 'readFile',
      description:
        'Reads an existing text file from the website workspace. Use this to inspect file content before making changes or to verify file references.',
      tier: 'informative',
      argsSchema: schema,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path to read'
          }
        },
        required: ['path']
      },
      execute: async ({ path: filePath }) => {
        const target = await this.safePath(filePath);
        try {
          const content = await fs.readFile(target, 'utf8');
          return content;
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            throw new Error(`File '${filePath}' does not exist.`);
          }
          throw err;
        }
      }
    };
  }

  // ==========================================
  // TOOL 4: LIST FILES (ENVIRONMENTAL EXPLORATION)
  // ==========================================
  public getListFilesTool(): Tool<{ path?: string }, string[]> {
    const schema = z.object({
      path: z.string().optional().describe('Relative directory path to list (defaults to project root)')
    });

    return {
      name: 'listFiles',
      description:
        'Lists all files and subdirectories inside a workspace directory. Use it to inspect current project structure.',
      tier: 'informative',
      argsSchema: schema,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative directory path to list (optional, defaults to workspace root)'
          }
        }
      },
      execute: async ({ path: dirPath = '.' }) => {
        const target = await this.safePath(dirPath);
        const entries = await fs.readdir(target, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      }
    };
  }

  /**
   * Aggregator returning all 4 workspace tools
   */
  public getAllTools(): Tool[] {
    return [
      this.getCreateDirectoryTool(),
      this.getWriteFileTool(),
      this.getReadFileTool(),
      this.getListFilesTool()
    ];
  }
}
```

---

## 6.3 Block-by-Block Explanation: `src/tools/workspace.tools.ts`

### Block 1: Constructor and Root Directory Anchoring
```typescript
export class WorkspaceTools {
  private readonly workspaceRoot: string;

  constructor(workspaceDir: string = 'generated-sites') {
    this.workspaceRoot = path.resolve(process.cwd(), workspaceDir);
  }
```
- **What this does:** Anchors the root directory of the sandbox at process start.
- **How it works:** Uses `path.resolve(process.cwd(), workspaceDir)` to compute an absolute canonical path. All file operations performed by the agent are anchored relative to this root path.

### Block 2: Hardened Security Path Resolver (`safePath`)
```typescript
  public async safePath(userPath: string): Promise<string> {
    const resolvedPath = path.resolve(this.workspaceRoot, userPath);

    if (!resolvedPath.startsWith(this.workspaceRoot)) {
      throw new Error(`Security Violation: Path '${userPath}' attempts to escape sandboxed workspace.`);
    }

    try {
      const realPath = await fs.realpath(resolvedPath);
      if (!realPath.startsWith(this.workspaceRoot)) {
        throw new Error(`Security Violation: Symlink at '${userPath}' resolves to target outside workspace.`);
      }
      return realPath;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return resolvedPath;
      }
      throw err;
    }
  }
```
- **What this does:** Prevents path traversal attacks (`../../etc/passwd`), root directory overwrites, and symlink escape exploits.
- **How it works:**
  1. Resolves and normalizes the target path against `workspaceRoot`.
  2. Verifies that the resolved path starts strictly with the prefix `this.workspaceRoot`.
  3. If the file exists on disk, invokes `fs.realpath` to resolve symbolic links and checks that the canonical physical destination also remains inside the sandbox.

### Block 3: Tool 1 — Directory Scaffolding (`createDirectory`)
```typescript
  public getCreateDirectoryTool(): Tool<{ path: string }, string> { ... }
```
- **What this does:** Creates dedicated project folders (e.g., `brewlab`).
- **How it works:** Resolves the path safely and invokes `fs.mkdir(target, { recursive: true })` so nested paths (e.g. `brewlab/assets/images`) are created without failing.

### Block 4: Tool 2 — Atomic File Writing (`writeFile`)
```typescript
  public getWriteFileTool(): Tool<{ path: string; content: string }, string> { ... }
```
- **What this does:** Creates or overwrites code files (`index.html`, `style.css`, `script.js`).
- **How it works:**
  - Enforces a 5MB payload limit to prevent disk flooding attacks.
  - Automatically creates parent directories via `fs.mkdir(path.dirname(target), { recursive: true })`.
  - Writes the string with explicit UTF-8 encoding.

### Block 5: Tools 3 & 4 — Environmental Observation (`readFile` & `listFiles`)
```typescript
  public getReadFileTool(): Tool<{ path: string }, string> { ... }
  public getListFilesTool(): Tool<{ path?: string }, string[]> { ... }
```
- **What this does:** Provides the agent with "eyes" to inspect the environment.
- **How it works:**
  - `listFiles` allows the agent to verify that all required assets exist.
  - `readFile` allows the agent to inspect generated HTML, check that `<link>` tags and `<script>` paths match file names, and self-repair broken references.

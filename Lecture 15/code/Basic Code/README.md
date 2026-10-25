# Lecture 15 — MCP Server: Resources and Prompts (Basic Code)

> **The code behind the notes.** One small MCP **server** that exposes all three
> primitives — **Tools** (*do*), **Resources** (*know*), **Prompts** (*reuse*) — plus the
> **host** that reads those Resources, fetches those Prompts and serves the lecture's
> own request: `GET /plan?hours=4`.

**Runs offline, with no API key.** Leave `OPENAI_API_KEY` empty and the client prints the
prompt it assembled instead of calling a model, so the whole Resource and Prompt half of the
protocol is reproducible on any machine.

```bash
cd "Lecture 15/code/Basic Code"
npm install

npm run lifecycle     # ONE command: starts the server, walks the whole lifecycle  ← start here
npm run typecheck     # tsc --noEmit
```

`npm run lifecycle` prints:

```text
[task-mcp-server] v1.0.0 MCP endpoint on http://127.0.0.1:8081/mcp

1. resources/list — discovery, not consumption
   task://guidelines
   task://backlog
   task://summary
   task://projects/{projectId}   (template)
   user://{userId}/profile   (template)

2. resources/read task://guidelines — a STATIC Resource
   Task Management Guidelines:
   1. Deep work tasks should preferably be done before 12 PM.
   ...

3. resources/read task://projects/fde — a TEMPLATED Resource, one definition
   Project: fde
   Tasks: 2
   - [open] Write MCP notes
   - [open] Review pull request

4. resources/read user://123/profile — a second template, same shape
   User: 123
   Open tasks: 2 of 2
   ...

5. prompts/list — which workflows exist?
   plan_day(availableHours)
   review_workload()

6. prompts/get plan_day { availableHours: "4" } — a template, not an answer
   Help me plan my pending tasks for today.
   First read my current pending tasks, then apply the task guidelines.
   I have 4 hours available today.
   ...

7. the model step, after prompts/get — GET /plan?hours=4 in miniature
   (offline — no OPENAI_API_KEY, so no model was called)
   USER:
   Help me plan my pending tasks for today.
   ...
```

The HTTP host needs **two terminals**:

```bash
npm run server        # terminal 1 — the MCP server, http://127.0.0.1:8081/mcp
npm run host          # terminal 2 — the application, http://127.0.0.1:8080
```

```bash
curl 'http://127.0.0.1:8080/resources'                      # discovery
curl 'http://127.0.0.1:8080/prompts'                        # the prompt menu
curl 'http://127.0.0.1:8080/read?uri=task://summary'        # consumption
curl 'http://127.0.0.1:8080/prompt?name=plan_day&hours=8'   # the QUESTION (no model)
curl 'http://127.0.0.1:8080/plan?hours=4'                   # the ANSWER
curl 'http://127.0.0.1:8080/ask?message=what%20is%20on%20my%20plate'
```

---

## Structure

```text
Basic Code/
├── .env                  # ports, identity, model name, API key (gitignored; see .env.example)
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
├── implementations guide/         # ← chapter-wise walkthrough of every file below
└── src/
    ├── index.ts                   # the MCP server process (Streamable HTTP, :8081)
    ├── config/config.ts           # identity, URI schemes, ports, model
    ├── server/server.ts           # createServer(): the "standard door"
    ├── services/taskService.ts    # the data layer (tasks + the text views)
    ├── services/resourceSelector.ts # how the APPLICATION picks a Resource
    ├── tools/tools.ts             # Tools — the MODEL holds the trigger
    ├── resources/resources.ts     # Resources — the APPLICATION holds it
    ├── prompts/prompts.ts         # Prompts — the USER holds the trigger
    ├── client/client.ts           # the MCP client + the lifecycle walkthrough
    └── routes/index.ts            # the HTTP host (Express): GET /plan?hours=4
```

### Chapter map

| Chapter | Where it lives |
|---|---|
| [01 — The Three Primitives and the Control Model](../../notes/01_The_Three_Primitives_and_the_Control_Model.md) | `server/server.ts` (all three registered in one function) |
| [02 — Why Resources](../../notes/02_Why_Resources_Context_as_a_First_Class_Primitive.md) | `tools/tools.ts` `list_tasks` vs `resources/resources.ts` `task://backlog` — same payload, different owner |
| [03 — Resource Discovery, Reading and Anatomy](../../notes/03_Resource_Discovery_Reading_and_Anatomy.md) | `resources/resources.ts` (name / URI / description / MIME type / content), `client/client.ts` (`resources/list` vs `resources/read`) |
| [04 — Static, Dynamic and Templated Resources](../../notes/04_Building_Resources_Static_Dynamic_and_Templated.md) | `resources/resources.ts` — five Resources, two of them `ResourceTemplate`s |
| [05 — How the Application Chooses a Resource](../../notes/05_How_the_Application_Chooses_a_Resource.md) | `services/resourceSelector.ts` — four strategies, each recording *why* |
| [06 — MCP Prompts: Reusable Interaction Templates](../../notes/06_MCP_Prompts_Reusable_Interaction_Templates.md) | `prompts/prompts.ts` — two templates, one with an argument |
| [07 — Prompt Arguments, Discovery and Client Wiring](../../notes/07_Prompt_Arguments_Discovery_and_Client_Wiring.md) | `prompts/prompts.ts` (`argsSchema`), `client/client.ts` (`getPromptText` vs `askModel`) |
| [08 — Bringing Tools, Resources and Prompts Together](../../notes/08_Bringing_Tools_Resources_and_Prompts_Together.md) | `routes/index.ts` — `GET /plan?hours=4` end to end |

> 📖 **Read the code with the guide.** [`implementations guide/`](./implementations%20guide/README.md)
> walks every file above in build order: file details, commands, the complete file, and a
> block-by-block explanation of what each part does and how it works.

---

## Three design decisions worth reading the code for

**1 · `list_tasks` and `task://backlog` return exactly the same text** (`src/tools/tools.ts` vs
`src/resources/resources.ts`)

Both call `backlogText()`. The payload is identical — the difference is **who decides**. The model
decides to call the Tool; the application decides to read the Resource. That pair of registrations
is Lecture 15's central argument in twenty lines.

**2 · A Resource URI is an identifier, not a URL** (`src/config/config.ts`)

`task://guidelines`, not `https://guidelines`. `https://` would promise that any client can fetch
it, and that is false — only this server can resolve it. The custom scheme keeps the address honest
and stops a host from trying to dereference something it should not.

**3 · `prompts/get` and the model call are different lines of code** (`src/client/client.ts`)

```ts
export async function planDay(client: Client, hours: string): Promise<string> {
  const prompt = await getPromptText(client, "plan_day", { availableHours: hours }); // MCP
  return askModel(prompt);                                                          // the model
}
```

`prompts/get` returns the **question**; `askModel` produces the **answer**. Two systems, two
credentials, two failure modes — separated by a blank line.

---

## Inspecting the server by hand

```bash
npm run server
```

```bash
# one raw JSON-RPC exchange — the reply declares all three capabilities
curl -s -X POST http://127.0.0.1:8081/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}'
```

```text
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"listChanged":true}},"serverInfo":{"name":"task-mcp-server","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

Or browse it with a UI:

```bash
npx @modelcontextprotocol/inspector --url http://127.0.0.1:8081/mcp
```

---

## Turning the model on

Put a key in `.env` and re-run:

```dotenv
OPENAI_API_KEY=sk-...
```

Steps 1–6 of `npm run lifecycle` stay byte-for-byte identical; only step 7 changes from an echo
into a real answer. That is the clearest proof that the protocol and the model are independent.

---

## Swapping the transport

`src/index.ts` is the only transport-aware file in the project. **Streamable HTTP** is what it
uses here; **STDIO** is the other local binding. Swapping it does not change `createServer()` at
all — which is Chapter 01's *"the binding is a detail, not a rewrite"*.

---

## What this project deliberately does *not* have

| Not present | Why |
|---|---|
| a database | `taskService` keeps tasks in an array; the lecture is about the protocol, not persistence |
| authentication | Chapter 08's production concern — see `Production Code` for that layer |
| LLM routing for resource selection | Chapter 05's expensive fifth strategy; the other four are enough to teach the point |
| a build step | `tsx` runs the TypeScript directly, so what you read is what runs |

**Back to:** [Lecture 15 notes](../../notes/README.md) · [Implementation guide](./implementations%20guide/README.md)



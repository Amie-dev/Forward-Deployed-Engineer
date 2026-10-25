import { randomUUID } from "node:crypto";
import { config } from "../config/config.js";
import type { AgentResponse, RetrievedDocument, ToolCall, Trace } from "../domain/types.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { orderIdIn, type ModelClient } from "./model.js";
import { runTool, toolNames } from "./tools.js";

/**
 * Chapter 02 §2.2 — the application under test.
 *
 * Three capabilities, one entry point:
 *
 *   Category A  policy question      retrieval, no tool
 *   Category B  order question       tool, no retrieval
 *   Category C  out of scope         neither, and a refusal
 *
 * Chapter 03's whole argument is visible in `chat()`: it returns **two** things.
 * The caller gets an answer; the tester gets a trace. A satisfying answer is not
 * evidence, and this method is where the evidence is collected.
 */
export class SupportAgent {
  constructor(
    private readonly model: ModelClient,
    private readonly knowledgeBase: KnowledgeBase = new KnowledgeBase(),
  ) {}

  /**
   * Chapter 03 §3.7 — one request, fully recorded.
   *
   * `caseId` is optional and is set only during an eval run. Chapter 03 §3.8 asks
   * for it because a failure has to map back to one readable row of the dataset —
   * "case 6 of the golden dataset" is a bug report; "some request" is not.
   */
  async chat(question: string, caseId?: string): Promise<AgentResponse> {
    const startedAt = Date.now();

    // Chapter 02 §2.2 — routing. An order question is answered from the order
    // tools and deliberately skips retrieval; a policy question is the other way
    // round. The dataset asserts both directions, so this one line is load-bearing:
    // it is what makes "no unexpected source" a meaningful check rather than a
    // check that can never fail.
    const retrieved =
      orderIdIn(question) === undefined ? this.knowledgeBase.search(question) : [];

    const toolCalls: ToolCall[] = [];
    let context = buildContext(retrieved, []);
    let turn = await this.model.answer({ question, context, toolNames });

    if (turn.kind === "tool") {
      // Chapter 02 §2.3 — a tool failure is a *result*, not an exception. The
      // agent has to be told "order not found" so that it can say so.
      const result = runTool(turn.name, turn.argument);
      toolCalls.push({ name: turn.name, argument: turn.argument, result });

      // Chapter 03 §3.7 — the context is assembled once, from retrieval *and*
      // tool results, and then recorded. Re-deriving it later is how you end up
      // judging context the model never saw.
      context = buildContext(retrieved, toolCalls.map((call) => call.result));

      // The second turn withholds the tools, so the model must answer.
      turn = await this.model.answer({ question, context, toolNames: [] });
    }

    if (turn.kind !== "answer") {
      throw new Error("The model requested a tool after the tool-call budget was spent");
    }

    const trace: Trace = {
      traceId: randomUUID(),
      ...(caseId === undefined ? {} : { caseId }),
      question,
      retrievedDocuments: retrieved,
      context,
      toolCalls,
      latencyMs: Date.now() - startedAt,
      model: this.model.version,
      promptVersion: config.promptVersion,
    };

    return {
      answer: turn.content,
      // Chapter 03 §3.4 — ids only, and an empty array is evidence, not missing
      // data: `toolsUsed: []` asserts that the tool path was *not* taken.
      retrievedDocuments: retrieved.map((document) => document.id),
      toolsUsed: toolCalls.map((call) => call.name),
      toolArguments: toolCalls.map((call) => call.argument),
      toolResults: toolCalls.map((call) => call.result),
      context,
      trace,
    };
  }
}

/**
 * Chapter 03 §3.7 — the context builder.
 *
 * It is a function rather than a few lines inside `chat()` for one reason: the
 * context is a *contract* between retrieval, tools and the judge. Everything the
 * judge is allowed to call "evidence" passes through here, so there is exactly one
 * definition of what evidence the model had.
 */
export function buildContext(retrieved: RetrievedDocument[], toolResults: string[]): string {
  const parts = retrieved.map((document) => `SOURCE: ${document.id}\n${document.text}`);

  toolResults.forEach((result, index) => {
    parts.push(`TOOL RESULT ${index + 1}: ${result}`);
  });

  return parts.join("\n\n");
}

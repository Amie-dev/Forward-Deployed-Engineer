import type { Request, Response } from "express";
import { appVersion, config } from "../config/config.js";
import { ASSET_CLASSES, GUARDRAIL_LAYERS, TOOL_TIERS } from "../domain/types.js";
import { auditLog, summarise } from "../services/audit.js";
import { CAPABILITY_MAP } from "../services/router.js";
import type { createScenarios } from "../services/scenarios.js";
import { TOOLS } from "../services/tools.js";

type Scenarios = ReturnType<typeof createScenarios>;

/**
 * Chapter 09 §9.10 — the security model, served as data.
 *
 * The point of this controller is that the security model is *inspectable*.
 * Chapter 09 §9.10 asks for a core model you can state in a sentence and review
 * as a whole; the cheapest way to make that true is to have the application
 * describe itself, so that "what can this agent reach?" is a request rather than
 * an archaeology exercise across five files.
 */
export function securityController(deps: { scenarios: Scenarios }) {
  return {
    index: (_request: Request, response: Response): void => {
      response.json({
        application: appVersion(),
        routes: [
          "POST /chat                        { user, message, confirmationId?, confirmArgs? }",
          "GET  /security                    the guardrails, tool tiers and capability map",
          "GET  /audit                       the recent traces, with what each layer did",
          "GET  /scenarios                   the eight attacks this project can run",
          "POST /attack/:scenario            run one attack and see the verdict",
        ],
      });
    },

    security: (_request: Request, response: Response): void => {
      response.json({
        principle:
          "The LLM can propose an action. It should never be the authority that decides whether the action is permitted.",
        assetClasses: ASSET_CLASSES,
        guardrailLayers: GUARDRAIL_LAYERS,
        guardrailsEnabled: config.guardrails,
        toolTiers: TOOL_TIERS,
        /** Chapter 07 §7.4 — intent to capability. Nothing else grants privileges. */
        capabilities: CAPABILITY_MAP,
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          tier: tool.tier,
          asset: tool.asset,
          schema: tool.schema,
          rowScoped: tool.rowScoped,
        })),
        limits: {
          topK: config.topK,
          autoApproveLimit: config.autoApproveLimit,
          maxToolCalls: config.maxToolCalls,
        },
      });
    },

    audit: (_request: Request, response: Response): void => {
      response.json({
        count: auditLog.length,
        entries: auditLog.map((trace) => ({
          requestId: trace.requestId,
          user: trace.user,
          question: trace.question,
          capabilities: trace.capabilities,
          retrieved: trace.retrieved,
          guardrails: trace.guardrails,
          toolCalls: trace.toolCalls,
          canaryLeaked: trace.canaryLeaked,
          refused: trace.refused,
          answer: trace.answer,
        })),
      });
    },

    scenarios: (_request: Request, response: Response): void => {
      response.json({
        scenarios: deps.scenarios.list.map(({ id, asset, user, question, forbidden, teaches }) => ({
          id,
          asset,
          user,
          question,
          forbidden,
          teaches,
        })),
      });
    },

    attack: async (request: Request, response: Response): Promise<void> => {
      const id = String(request.params.scenario ?? "");

      try {
        const outcome = await deps.scenarios.run(id);

        // Chapter 09 §9.13 — the status code is the verdict, so CI can read it
        // without parsing prose. A forbidden effect is a failed security test.
        response.status(outcome.violated.length === 0 ? 200 : 500).json({
          scenario: outcome.scenario.id,
          teaches: outcome.scenario.teaches,
          note: outcome.note,
          verdict: outcome.violated.length === 0 ? "contained" : "VIOLATED",
          violated: outcome.violated,
          effects: outcome.effects,
          answer: outcome.result.answer,
          trace: outcome.result.trace,
          summary: summarise(outcome.result.trace),
        });
      } catch (error) {
        response.status(404).json({
          error: {
            message: (error as Error).message,
            recovery: "Call GET /scenarios for the list of attack ids.",
          },
        });
      }
    },
  };
}

import { randomUUID } from "node:crypto";
import type { EvalCase } from "../domain/types.js";

/**
 * Chapter 09 §9.3 — **online evaluation**.
 *
 * Offline evaluation tells you whether you *broke* something you already knew
 * about. Online evaluation tells you what you *didn't* know about (§9.2: the
 * "distribution gap" between `"What is the return period?"` and
 * `"bro bought this yesterday but box gone can return???"`).
 *
 * This is the smallest honest version of the second half: record what real
 * interactions looked like, collect the two kinds of feedback the lecture names,
 * and — §9.5 — turn failures into candidate regression tests.
 */

export interface Interaction {
  id: string;
  input: string;
  answer: string;
  at: string;
  /** §9.3 "Explicit feedback" — 👍 / 👎. High signal, low volume. */
  explicit?: "up" | "down";
  /**
   * §9.3 "Implicit feedback" — behaviour as signal. The lecture's own example:
   * the user asks the same question again, which "may indicate that the first
   * answer was not useful".
   */
  repeated: boolean;
}

export interface OnlineSnapshot {
  interactions: number;
  explicitUp: number;
  explicitDown: number;
  repeated: number;
  /** §9.3 — "most users never click anything", so the rate is reported with its denominator. */
  explicitCoverage: number;
  repeatRate: number;
  /** The promotion queue: anything marked down, or asked twice. */
  candidates: Interaction[];
}

export function createOnlineMonitor() {
  const interactions: Interaction[] = [];

  return {
    record(input: string, answer: string): Interaction {
      const interaction: Interaction = {
        id: randomUUID().slice(0, 8),
        input,
        answer,
        at: new Date().toISOString(),
        repeated: false,
      };

      // Implicit signal: an identical question arriving again means the previous
      // answer did not land. Mark the *earlier* interaction, because that is the
      // one that failed.
      const previous = interactions.find((candidate) => candidate.input === input);

      if (previous !== undefined) {
        previous.repeated = true;
      }

      interactions.push(interaction);

      return interaction;
    },

    feedback(id: string, verdict: "up" | "down"): Interaction | undefined {
      const interaction = interactions.find((candidate) => candidate.id === id);

      if (interaction !== undefined) {
        interaction.explicit = verdict;
      }

      return interaction;
    },

    snapshot(): OnlineSnapshot {
      const up = interactions.filter((candidate) => candidate.explicit === "up").length;
      const down = interactions.filter((candidate) => candidate.explicit === "down").length;
      const repeated = interactions.filter((candidate) => candidate.repeated).length;
      const total = interactions.length;

      return {
        interactions: total,
        explicitUp: up,
        explicitDown: down,
        repeated,
        explicitCoverage: total === 0 ? 0 : Number(((up + down) / total).toFixed(2)),
        repeatRate: total === 0 ? 0 : Number((repeated / total).toFixed(2)),
        candidates: interactions.filter(
          (candidate) => candidate.explicit === "down" || candidate.repeated,
        ),
      };
    },

    /**
     * §9.5 — **the loop**: "production failures become future regression tests.
     * This creates a continuous improvement loop."
     *
     * Read the returned shape carefully, because the split is the lesson. The
     * *input* is captured automatically — that is the mechanical half. The
     * **expected behaviour** is not, and cannot be: deciding what the system
     * *should* have said is a human judgement (Chapter 07 §7.7). So this returns
     * a stub with an empty `expected` and says so, rather than inventing an
     * assertion from the answer that was already wrong.
     */
    promote(id: string): { testCase: EvalCase; note: string } | undefined {
      const interaction = interactions.find((candidate) => candidate.id === id);

      if (interaction === undefined) {
        return undefined;
      }

      return {
        testCase: {
          id: `prod-${interaction.id}`,
          category: "edge",
          input: interaction.input,
          expected: {},
          evaluators: [{ kind: "code", checks: ["json-valid", "schema-valid"] }],
        },
        note:
          "Captured from production. Fill in `expected` (mustMention / mustNotClaim / expectedDocs) " +
          "and add the judge evaluators you want, then bump the dataset revision — an unasserted case " +
          "cannot gate anything.",
      };
    },
  };
}

export type OnlineMonitor = ReturnType<typeof createOnlineMonitor>;

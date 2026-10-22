import { readFile } from 'node:fs/promises';

import type { RagConfig } from '../config/env.js';
import { paths } from '../config/env.js';
import { RagPipeline } from '../pipeline.js';
import type { AccessContext } from '../types.js';
import { evaluateCase, summarise, type CaseEvaluation, type GoldenCase, type SuiteSummary } from './metrics.js';

/**
 * The ablation matrix.
 *
 * One preset per row, one control changed per row, so a difference in the numbers
 * can only have one cause. This is the answer to "is reranking worth it?" that
 * survives a review: not an opinion, and not a vendor benchmark — the same fourteen
 * questions, the same corpus, one knob at a time.
 */

export interface Preset {
  name: string;
  description: string;
  overrides: Partial<RagConfig>;
}

const NAIVE: Partial<RagConfig> = {
  chunkStrategy: 'fixed',
  chunkUnit: 'chars',
  chunkSize: 1000,
  chunkOverlap: 150,
  contextualize: 'none',
  lateChunkAlpha: 0,
  kRetrieve: 4,
  kContext: 4,
  minScore: -1,
  mmrLambda: 0,
  hybrid: 'off',
  rerank: 'none',
  expandParents: false,
  bookendOrder: false,
};

export const PRESETS: Preset[] = [
  { name: 'naive', description: 'fixed 1,000 chars · top-4 · no floor · no hybrid · no rerank', overrides: NAIVE },
  {
    name: 'structural',
    description: '+ structural chunks + contextual prefix + floor',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15 },
  },
  {
    name: 'hybrid',
    description: '+ BM25 and reciprocal rank fusion',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15, hybrid: 'rrf' },
  },
  {
    name: 'rerank',
    description: '+ cross-encoder rerank with the two-sided gate',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15, hybrid: 'rrf', rerank: 'heuristic' },
  },
  {
    name: 'full',
    description: '+ parent expansion and bookend ordering',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 5, minScore: 0.15, hybrid: 'rrf', rerank: 'heuristic', expandParents: true, bookendOrder: true },
  },
  {
    name: 'full-wide',
    description: 'same, but 8 candidates to collapse into complete parents',
    overrides: { ...NAIVE, chunkStrategy: 'structural', chunkUnit: 'tokens', chunkSize: 400, chunkOverlap: 80, contextualize: 'template', kRetrieve: 25, kContext: 8, minScore: 0.15, hybrid: 'rrf', rerank: 'heuristic', expandParents: true, bookendOrder: true },
  },
];

export async function loadGoldenCases(): Promise<GoldenCase[]> {
  const raw = JSON.parse(await readFile(paths.golden, 'utf8')) as { cases: GoldenCase[] };
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error('golden.json has no cases.');
  return raw.cases;
}

export interface SuiteResult {
  evaluations: CaseEvaluation[];
  summary: SuiteSummary;
}

export async function runSuite(
  pipeline: RagPipeline,
  cases: readonly GoldenCase[],
  baseAccess: AccessContext,
): Promise<SuiteResult> {
  const evaluations: CaseEvaluation[] = [];

  for (const testCase of cases) {
    const access: AccessContext = { ...baseAccess, asOf: testCase.asOf };
    const result = await pipeline.ask(testCase.question, { access });
    evaluations.push(evaluateCase(testCase, result));
  }

  return { evaluations, summary: summarise(evaluations) };
}

export interface AblationRow {
  name: string;
  description: string;
  summary: SuiteSummary;
  chunks: number;
  indexMs: number;
}

export async function runAblation(
  cases: readonly GoldenCase[],
  baseAccess: AccessContext,
  presets: readonly Preset[] = PRESETS,
): Promise<AblationRow[]> {
  const rows: AblationRow[] = [];

  for (const preset of presets) {
    const pipeline = await RagPipeline.create(preset.overrides);
    const { summary } = await runSuite(pipeline, cases, baseAccess);
    rows.push({
      name: preset.name,
      description: preset.description,
      summary,
      chunks: pipeline.stats.chunks,
      indexMs: pipeline.stats.embedMs,
    });
  }

  return rows;
}

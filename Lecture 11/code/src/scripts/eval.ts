import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContainer } from '../container.js';

interface GoldenCase {
  id: string;
  question: string;
  /** Source files that must appear in the retrieved context. Empty = unanswerable. */
  expectedSources: string[];
  answerable: boolean;
  /** Substrings the answer must contain. Case-insensitive. */
  mustContain?: string[];
}

const GOLDEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval/golden.json');

const cases = JSON.parse(await readFile(GOLDEN_PATH, 'utf8')) as GoldenCase[];
const container = await createContainer();

const report = await container.service.ingest();
console.log(`[eval] indexed ${report.chunks} chunks into ${report.store}\n`);

let recallSum = 0;
let citationsValid = 0;
let refusalsCorrect = 0;
let factsPresent = 0;

const rows = [];

for (const testCase of cases) {
  const result = await container.service.ask({ question: testCase.question });

  const retrieved = new Set(result.trace.matches.map((match) => match.source));
  const hits = testCase.expectedSources.filter((source) => retrieved.has(source)).length;
  const recall = testCase.expectedSources.length === 0 ? 1 : hits / testCase.expectedSources.length;

  const citationsOk = result.citations.every((citation) => citation.valid);
  const refusalOk = result.refused === !testCase.answerable;
  const factsOk = (testCase.mustContain ?? []).every((term) =>
    result.answer.toLowerCase().includes(term.toLowerCase()),
  );

  recallSum += recall;
  if (citationsOk) citationsValid++;
  if (refusalOk) refusalsCorrect++;
  if (factsOk) factsPresent++;

  rows.push({
    case: testCase.id,
    recall: `${hits}/${testCase.expectedSources.length}`,
    citations: citationsOk ? 'ok' : 'INVALID',
    refused: result.refused ? 'yes' : 'no',
    refusal: refusalOk ? 'ok' : 'WRONG',
    facts: factsOk ? 'ok' : 'MISSING',
    ms: result.trace.latencyMs.total,
  });
}

console.table(rows);

const total = cases.length;
console.log(`[eval] recall@${container.env.TOP_K}    ${(recallSum / total).toFixed(2)}`);
console.log(`[eval] citations      ${citationsValid}/${total}`);
console.log(`[eval] refusals       ${refusalsCorrect}/${total}`);
console.log(`[eval] expected facts ${factsPresent}/${total}`);

const failures = rows.filter((row) => row.refusal === 'WRONG' || row.facts === 'MISSING' || row.citations === 'INVALID');
if (failures.length > 0) {
  console.error(`\n[eval] ${failures.length} failing case(s): ${failures.map((row) => row.case).join(', ')}`);
  process.exitCode = 1;
}

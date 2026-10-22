#!/usr/bin/env node
import { config, defaultAccess, paths } from './config/env.js';
import { createEmbeddings } from './embeddings.js';
import { buildIndex } from './ingest/indexer.js';
import { loadDocuments } from './ingest/loader.js';
import { RagPipeline } from './pipeline.js';
import { diagnose } from './eval/diagnose.js';
import { PRESETS, loadGoldenCases, runAblation, runSuite } from './eval/run.js';
import { sweepFloors, type CaseCandidates } from './search/calibrate.js';
import { compileFilter, describeFilter, parseFilter } from './store/filters.js';
import type { AccessContext } from './types.js';

/**
 * One CLI, one subcommand per chapter.
 *
 * Every command exists to make one claim checkable:
 *
 *   chunks     what the corpus actually turned into
 *   baseline   what breaks, and where
 *   search     which control changed the ranking, and by how much
 *   ask        the full answer, its citations and its trace
 *   calibrate  which score floor the data supports
 *   filters    who can see what, and as of when
 *   ablation   which controls earn their cost
 *   eval       the current configuration, scored
 */

const commands = ['chunks', 'baseline', 'search', 'ask', 'calibrate', 'filters', 'ablation', 'eval'] as const;
type Command = (typeof commands)[number];

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || !commands.includes(command as Command)) {
    console.log(`Usage: npm run cli -- <${commands.join('|')}> [query|preset]`);
    console.log('');
    console.log('  chunks [detail]        chunk counts per strategy; "detail" lists real chunks');
    console.log('  baseline               the naive pipeline, scored and diagnosed');
    console.log('  search "question"      ranked candidates with every score');
    console.log('  ask "question"         answer, citations and stage trace');
    console.log('  calibrate              sweep both score floors against the golden set');
    console.log('  filters                tenant, ACL, temporal and pre/post filter behaviour');
    console.log('  ablation               one control at a time, same questions');
    console.log('  eval [preset]          score the configured pipeline, or one preset');
    return;
  }

  switch (command as Command) {
    case 'chunks':
      return chunkReport(rest[0] === 'detail');
    case 'baseline':
      return baseline();
    case 'search':
      return searchCommand(rest.join(' '));
    case 'ask':
      return askCommand(rest.join(' '));
    case 'calibrate':
      return calibrateCommand();
    case 'filters':
      return filtersCommand();
    case 'ablation':
      return ablationCommand();
    case 'eval':
      return evalCommand(rest[0]);
  }
}

/** Chapter 02 + 03: what each chunking strategy does to the same eight documents. */
async function chunkReport(detail = false): Promise<void> {
  const docs = await loadDocuments(paths.policies);
  const embeddings = createEmbeddings({ ...config.embedding, openaiApiKey: config.openaiApiKey });
  const base = {
    parentMaxTokens: config.parentMaxTokens,
    minChunkTokens: config.minChunkTokens,
    contextualize: 'none' as const,
    lateChunkAlpha: 0,
    embeddings,
    openaiApiKey: config.openaiApiKey,
    chatModel: config.generation.model,
    semanticThreshold: 0.35,
  };

  const variants = [
    { label: 'fixed · 1,000 chars / 150', strategy: 'fixed' as const, chunkSize: 1000, chunkOverlap: 150, chunkUnit: 'chars' as const },
    { label: 'fixed · 400 tokens / 80', strategy: 'fixed' as const, chunkSize: 400, chunkOverlap: 80, chunkUnit: 'tokens' as const },
    { label: 'fixed · 400 tokens / 200', strategy: 'fixed' as const, chunkSize: 400, chunkOverlap: 200, chunkUnit: 'tokens' as const },
    { label: 'structural · 400 / 80', strategy: 'structural' as const, chunkSize: 400, chunkOverlap: 80, chunkUnit: 'tokens' as const },
    { label: 'semantic · 400 max', strategy: 'semantic' as const, chunkSize: 400, chunkOverlap: 0, chunkUnit: 'tokens' as const },
  ];

  const rows: string[][] = [];

  for (const variant of variants) {
    const index = await buildIndex(docs, { ...base, ...variant });
    rows.push([
      variant.label,
      String(index.stats.chunks),
      String(index.stats.averageTokens),
      `${index.stats.storageMultiplier}×`,
      String(index.stats.orphans),
      index.records[0]?.breadcrumb || '—',
    ]);
  }

  console.log(`Corpus: ${docs.length} documents\n`);
  console.log(table(['strategy', 'chunks', 'avg tok', 'storage', 'orphans', 'first breadcrumb'], rows));
  console.log('\nOrphans = chunks under 30 tokens or starting mid-sentence. They match on a');
  console.log('stray word and carry no subject to contradict the match.');

  if (!detail) return;

  // The detail view is the one that shows *why* the numbers differ: what a chunk
  // is actually called, what it is attached to, and what gets embedded.
  const fixedIndex = await buildIndex(docs, { ...base, strategy: 'fixed', chunkSize: 1000, chunkOverlap: 150, chunkUnit: 'chars' });
  const structuralIndex = await buildIndex(docs, { ...base, strategy: 'structural', chunkSize: 400, chunkOverlap: 80, chunkUnit: 'tokens', contextualize: 'template' });

  const describe = (index: Awaited<ReturnType<typeof buildIndex>>, limit: number): string[][] =>
    index.records.slice(0, limit).map((record, position) => [
      String(position + 1),
      record.source.replace('.md', ''),
      record.heading || '(none)',
      String(record.tokens),
      record.parentId ? 'yes' : 'no',
      record.contextPrefix ? 'yes' : 'no',
      record.text.slice(0, 34).replace(/\s+/g, ' '),
    ]);

  console.log('\n\nFixed · 1,000 chars / 150 — no heading, no parent, no context:');
  console.log(table(['#', 'source', 'heading', 'tok', 'parent', 'context', 'text…'], describe(fixedIndex, 6)));

  console.log('\n\nStructural · 400 tokens / 80 + contextual prefix:');
  console.log(table(['#', 'source', 'heading', 'tok', 'parent', 'context', 'text…'], describe(structuralIndex, 6)));
}

/** Chapter 01: the naive pipeline, and the tree that says where it failed. */
async function baseline(): Promise<void> {
  const cases = await loadGoldenCases();
  const pipeline = await RagPipeline.create(PRESETS[0].overrides);
  const access = defaultAccess();

  console.log(`Baseline: ${PRESETS[0].description}`);
  console.log(
    `Corpus:   ${pipeline.stats.documents} docs → ${pipeline.stats.chunks} chunks (${pipeline.stats.averageTokens} avg tokens)\n`,
  );

  const rows: string[][] = [];

  for (const testCase of cases) {
    const result = await pipeline.ask(testCase.question, { access: { ...access, asOf: testCase.asOf } });
    const diagnosis = diagnose({
      testCase,
      refused: result.refused,
      answer: result.answer,
      contextText: result.context.text,
      retrievedSources: result.trace.retrieved.filter((row) => row.used).map((row) => row.source),
    });

    rows.push([
      testCase.id,
      diagnosis.verdict,
      diagnosis.step,
      result.trace.retrieved
        .filter((row) => row.used)
        .slice(0, 3)
        .map((row) => row.source.replace('.md', ''))
        .join(',') || '—',
      diagnosis.reason.slice(0, 52),
    ]);
  }

  console.log(table(['case', 'verdict', 'step', 'evidence used', 'reason'], rows));

  const broken = rows.filter((row) => row[1] !== 'ok' && row[1] !== 'refusal-ok').length;
  console.log(`\n${broken}/${rows.length} cases failed. Every row names the stage that broke.`);
}

/** Chapters 04-08: every score that touched each candidate, side by side. */
async function searchCommand(question: string): Promise<void> {
  if (!question) throw new Error('Pass a question: npm run cli -- search "return window for headphones"');

  const pipeline = await RagPipeline.create();
  const access = defaultAccess();
  const run = await pipeline.retrieve(question, { access });

  const rows = run.fused.slice(0, 10).map((hit, index) => {
    const dense = run.dense.find((candidate) => candidate.chunk.id === hit.chunk.id);
    const lexical = run.lexical.find((candidate) => candidate.chunk.id === hit.chunk.id);
    const reranked = run.reranked.find((candidate) => candidate.chunk.id === hit.chunk.id);
    const used = run.hits.some((candidate) => candidate.chunk.id === hit.chunk.id);

    return [
      String(index + 1),
      hit.chunk.source.replace('.md', ''),
      (hit.chunk.heading || '(no heading)').slice(0, 24),
      dense ? dense.score.toFixed(3) : '—',
      lexical ? lexical.score.toFixed(2) : '—',
      hit.score.toFixed(4),
      reranked ? reranked.score.toFixed(3) : '—',
      used ? 'yes' : '',
    ];
  });

  console.log(`Question: ${question}`);
  console.log(
    `Config:   hybrid=${pipeline.config.hybrid} rerank=${pipeline.config.rerank} k=${pipeline.config.kRetrieve}/${pipeline.config.kContext} floor=${pipeline.config.minScore}\n`,
  );
  console.log(table(['#', 'source', 'heading', 'dense', 'bm25', 'rrf', 'rerank', 'kept'], rows));

  console.log('\nStages:');
  for (const stage of run.stages) console.log(`  ${stage.name.padEnd(8)} ${String(stage.ms).padStart(4)}ms  ${stage.detail}`);
}

/** Chapters 08-10: the answer a customer would see, plus the reason it is defensible. */
async function askCommand(question: string): Promise<void> {
  if (!question) throw new Error('Pass a question: npm run cli -- ask "is the AX-204 still under warranty?"');

  const pipeline = await RagPipeline.create();
  const result = await pipeline.ask(question, { access: defaultAccess() });

  console.log(`Q: ${question}\n`);
  console.log(`A: ${result.answer}\n`);

  if (result.citations.length > 0) {
    console.log('Citations:');
    for (const citation of result.citations) {
      console.log(`  [${citation.label}] ${citation.valid ? 'ok' : 'INVALID'}  ${citation.source} › ${citation.heading}`);
    }
  } else {
    console.log('Citations: none');
  }

  console.log('\nContext blocks:');
  for (const block of result.context.blocks) {
    const scope = block.specificity >= 3 ? 'specific' : 'general';
    console.log(
      `  [${block.label}] ${block.source} › ${block.heading} · ${block.tokens} tok · ${scope}${block.expanded ? ' · parent' : ''}`,
    );
  }

  console.log('\nTrace:');
  for (const stage of result.trace.stages) {
    console.log(`  ${stage.name.padEnd(8)} ${String(stage.ms).padStart(4)}ms  ${stage.detail}`);
  }
  console.log(
    `  total    ${String(result.trace.latencyMs).padStart(4)}ms  ${result.trace.candidates} candidates · ${result.trace.contextTokens} context tokens · ${result.trace.invalidCitations} invalid citations`,
  );
}

function table(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();

  return [line(headers), widths.map((width) => '─'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

/**
 * Chapter 05 + 08: both floors are measured numbers, not feelings.
 *
 * Two sweeps, because there are two gates and they are not interchangeable:
 *  - the **dense floor** decides when the retriever has found nothing, on a scale
 *    (cosine) that depends on the embedding model;
 *  - the **rerank floor** decides when the cross-encoder has found nothing, on a
 *    scale that depends on the reranker. A lexical stand-in compresses its scores
 *    into a narrow band, so a floor that looks reasonable for Cohere's relevance
 *    scores will reject everything here.
 */
async function calibrateCommand(): Promise<void> {
  const cases = await loadGoldenCases();
  const access = defaultAccess();

  // Sweep 1: raw dense candidates — no floor, no fusion, no rerank.
  const densePipeline = await RagPipeline.create({
    minScore: -1,
    hybrid: 'off',
    rerank: 'none',
    kRetrieve: 25,
    kContext: 25,
  });

  const denseBatches: CaseCandidates[] = [];
  for (const testCase of cases) {
    const run = await densePipeline.retrieve(testCase.question, { access: { ...access, asOf: testCase.asOf } });
    denseBatches.push({ testCase, hits: run.hits });
  }

  // Sweep 2: reranked candidates — the fusion arm is on, the gate is not.
  const rerankPipeline = await RagPipeline.create({
    minScore: -1,
    hybrid: 'rrf',
    rerank: 'heuristic',
    rerankMinBest: 0,
    rerankMaxDrop: 1,
    kRetrieve: 25,
    kContext: 25,
  });

  const rerankBatches: CaseCandidates[] = [];
  for (const testCase of cases) {
    const run = await rerankPipeline.retrieve(testCase.question, { access: { ...access, asOf: testCase.asOf } });
    rerankBatches.push({ testCase, hits: run.reranked });
  }

  const dense = sweepFloors(denseBatches, { k: 5, mode: 'absolute' });
  const rerank = sweepFloors(rerankBatches, {
    floors: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6],
    k: 5,
    mode: 'best',
    maxDrop: rerankPipeline.config.rerankMaxDrop,
  });

  const render = (title: string, result: ReturnType<typeof sweepFloors>): void => {
    console.log(`\n${title}`);
    console.log(
      table(
        ['floor', 'chunks/answer', 'recall', 'refusal', 'balanced', ''],
        result.rows.map((row) => [
          row.floor.toFixed(2),
          row.kept.toFixed(1),
          row.recall.toFixed(3),
          row.refusal.toFixed(3),
          row.balanced.toFixed(3),
          row.floor === result.recommended ? '← pick' : '',
        ]),
      ),
    );
    console.log(result.note);
  };

  console.log(`Calibration over ${cases.length} golden cases (${densePipeline.stats.chunks} chunks)`);
  render(`Dense floor — ${densePipeline.config.embedding.model}`, dense);
  render('Rerank floor — heuristic scorer', rerank);

  console.log('\nBalanced = mean(answerable recall, unanswerable refusal). Ties go to the higher');
  console.log('floor: same measured quality for fewer tokens. Set MIN_SCORE and');
  console.log('RERANK_MIN_BEST from this output, and re-run it whenever the embedder, the');
  console.log('corpus or the reranker changes.');
}

/** Chapter 06: access control and time are filters, and they fail closed. */
async function filtersCommand(): Promise<void> {
  const pipeline = await RagPipeline.create({ hybrid: 'off', rerank: 'none' });
  const records = pipeline.records;
  const access = defaultAccess();

  const count = (scope: AccessContext, expression?: string): number => {
    const predicate = compileFilter(expression ? parseFilter(expression) : undefined, scope);
    return records.filter((record) => predicate(record.meta)).length;
  };

  console.log(
    `Index: ${records.length} chunks · tenant ${access.tenantId} · acl [${access.acl.join(', ')}] · asOf ${access.asOf}\n`,
  );

  const expression = 'category in [electronics, general]';
  const rows = [
    ['no filter', String(records.length), 'every chunk is visible to this caller'],
    [expression, String(count(access, expression)), 'narrower caller filter, same access'],
    ['tenant = other-tenant', String(count({ ...access, tenantId: 'other-tenant' })), 'fail closed: no tenant match'],
    ['acl = [anonymous]', String(count({ ...access, acl: ['anonymous'] })), 'fail closed: no group overlap'],
    ['asOf = 2026-06-01', String(count({ ...access, asOf: '2026-06-01' })), 'current policies only'],
    ['asOf = 2025-06-01', String(count({ ...access, asOf: '2025-06-01' })), 'superseded 2025 policy becomes visible'],
  ];

  console.log(table(['filter', 'chunks', 'why'], rows));

  // Pre- vs post-filtering, with the same question and the same predicate. The
  // filter is deliberately narrow: the point is that top-K slots are spent before
  // the predicate runs, so the eligible documents never get a chance.
  const embeddings = createEmbeddings({ ...config.embedding, openaiApiKey: config.openaiApiKey });
  const [vector] = await embeddings.embed(['warranty coverage for the AX-204']);
  const narrow = 'category == shipping';
  const predicate = compileFilter(parseFilter(narrow), access);

  const pre = pipeline.store.query({ vector, topK: 5, predicate, mode: 'pre' });
  const post = pipeline.store.query({ vector, topK: 5, predicate, mode: 'post' });

  console.log(`\nFilter "${describeFilter(parseFilter(narrow))}", top-5:`);
  console.log(`  pre-filter   ${pre.hits.length} hits  (${pre.scanned} scanned, ${pre.eligible} eligible)`);
  console.log(`  post-filter  ${post.hits.length} hits  (${post.eligible} eligible, but K slots were spent first)`);
  console.log('Post-filtering is how a system returns "no results" while the answer sits in the index.');
}

/** Chapter 10: one control changed per row, same fourteen questions. */
async function ablationCommand(): Promise<void> {
  const cases = await loadGoldenCases();
  const rows = await runAblation(cases, defaultAccess());

  console.log(`Ablation over ${cases.length} golden cases\n`);
  console.log(
    table(
      ['preset', 'chunks', 'recall', 'mrr', 'ndcg', 'refusal', 'falseRef', 'ctx tok', 'p50'],
      rows.map((row) => [
        row.name,
        String(row.chunks),
        row.summary.recall.toFixed(3),
        row.summary.mrr.toFixed(3),
        row.summary.ndcg.toFixed(3),
        row.summary.refusalAccuracy.toFixed(3),
        row.summary.falseRefusal.toFixed(3),
        String(row.summary.averageContextTokens),
        `${row.summary.p50LatencyMs}ms`,
      ]),
    ),
  );

  console.log('\nWhat to read:');
  for (const row of rows) console.log(`  ${row.name.padEnd(11)} ${row.description}`);
  console.log('\nThis table measures retrieval, because that is what the presets change.');
  console.log('Answer-level metrics live in `npm run cli -- eval <preset>`, where a weak');
  console.log('generator can be told apart from weak retrieval.');
  console.log('If a row does not move recall but raises ctx tokens, it is costing money for nothing.');
}

/** Chapter 10: the current configuration, scored case by case. Optionally per preset. */
async function evalCommand(presetName?: string): Promise<void> {
  const cases = await loadGoldenCases();
  const preset = presetName ? PRESETS.find((candidate) => candidate.name === presetName) : undefined;

  if (presetName && !preset) {
    throw new Error(`Unknown preset "${presetName}". Available: ${PRESETS.map((entry) => entry.name).join(', ')}.`);
  }

  const pipeline = await RagPipeline.create(preset?.overrides ?? {});
  const { evaluations, summary } = await runSuite(pipeline, cases, defaultAccess());

  console.log(`Preset: ${preset?.name ?? 'env defaults'} — ${preset?.description ?? 'CHUNK_STRATEGY/CHUNK_SIZE from .env'}`);
  console.log(
    `Config: ${pipeline.stats.strategy} · ${pipeline.stats.chunks} chunks · hybrid=${pipeline.config.hybrid} · rerank=${pipeline.config.rerank} · floor=${pipeline.config.minScore}\n`,
  );

  console.log(
    table(
      ['case', 'ans', 'refused', 'recall', 'mrr', 'ndcg', 'facts', 'cites'],
      evaluations.map((evaluation) => [
        evaluation.id,
        evaluation.answerable ? 'yes' : 'no',
        evaluation.refused ? 'yes' : 'no',
        evaluation.recall.toFixed(2),
        evaluation.mrr.toFixed(2),
        evaluation.ndcg.toFixed(2),
        evaluation.factMatch ? 'ok' : 'MISS',
        evaluation.citationValidity.toFixed(2),
      ]),
    ),
  );

  console.log(
    `\nrecall ${summary.recall.toFixed(3)} · mrr ${summary.mrr.toFixed(3)} · ndcg ${summary.ndcg.toFixed(3)} · facts ${summary.factAccuracy.toFixed(3)} · refusal ${summary.refusalAccuracy.toFixed(3)} · ${summary.averageContextTokens} ctx tokens · p50 ${summary.p50LatencyMs}ms`,
  );
}

main().catch((error: unknown) => {
  console.error(`\n[cli] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

import { createContainer } from '../container.js';

const question = process.argv.slice(2).join(' ').trim();

if (!question) {
  console.error('Usage: npm run ask -- "What is the refund window for apparel?"');
  process.exit(1);
}

const container = await createContainer();

if ((await container.store.count()) === 0) {
  const report = await container.service.ingest();
  console.log(`[ask] index was empty, ingested ${report.chunks} chunks first`);
}

const result = await container.service.ask({ question });

console.log(`\n${result.answer}\n`);

for (const citation of result.citations) {
  const status = citation.valid ? 'ok' : 'INVALID';
  console.log(
    `  [${citation.label}] ${status.padEnd(7)} ${citation.source} · ${citation.section} ` +
      `(score ${citation.score.toFixed(3)})`,
  );
}

const { trace } = result;
console.log(
  `\n[trace] searchQuery="${trace.searchQuery}" candidates=${trace.candidates} ` +
    `matches=${trace.matches.length} contextTokens=${trace.contextTokens} ` +
    `invalidCitations=${trace.invalidCitations} refused=${trace.refused}`,
);
console.log(
  `[trace] embed=${trace.latencyMs.embed}ms search=${trace.latencyMs.search}ms ` +
    `generate=${trace.latencyMs.generate}ms total=${trace.latencyMs.total}ms`,
);
console.log(`[trace] sessionId=${result.sessionId}`);

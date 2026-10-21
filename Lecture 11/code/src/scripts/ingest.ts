import { createContainer } from '../container.js';

const container = await createContainer();
const report = await container.service.ingest();

console.log(
  `[ingest] store=${report.store} documents=${report.documents} chunks=${report.chunks} ` +
    `tokens=${report.tokens} ${report.durationMs}ms`,
);

if (report.skipped.length > 0) {
  console.warn(`[ingest] skipped, no extractable text: ${report.skipped.join(', ')}`);
}

if (report.staleSourcesRemoved.length > 0) {
  console.log(`[ingest] removed deleted sources: ${report.staleSourcesRemoved.join(', ')}`);
}

console.log(`[ingest] index now holds ${await container.store.count()} chunks`);

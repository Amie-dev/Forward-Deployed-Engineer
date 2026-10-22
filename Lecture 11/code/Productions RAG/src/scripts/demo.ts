/**
 * Offline walkthrough of the whole pipeline.
 *
 * Forces the deterministic providers before anything reads configuration, so
 * `npm run demo` works with no API key and prints the same numbers every run.
 */
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'extractive';

import { buildGroundedPrompt } from '../generation/prompt.js';
import { chunkDocument } from '../ingest/chunker.js';
import { loadDocuments } from '../ingest/loader.js';

const { createContainer } = await import('../container.js');

function heading(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

const container = await createContainer();
const { env, service, store, retriever, generator } = container;

heading('1. Configuration');
console.log(`embeddings  ${env.EMBEDDING_PROVIDER}/${env.EMBEDDING_MODEL} (${env.EMBEDDING_DIMENSIONS} dims)`);
console.log(`generation  ${generator.name}/${generator.model}`);
console.log(`store       ${env.VECTOR_STORE}`);
console.log(`chunking    size=${env.CHUNK_SIZE} overlap=${env.CHUNK_OVERLAP} topK=${env.TOP_K} floor=${env.MIN_SCORE}`);

heading('2. Ingestion — documents become chunks');
const documents = await loadDocuments(env.KNOWLEDGE_DIR);
for (const document of documents) {
  const chunks = chunkDocument(document, { size: env.CHUNK_SIZE, overlap: env.CHUNK_OVERLAP });
  const first = chunks[0];
  console.log(`${document.source.padEnd(22)} ${String(chunks.length).padStart(2)} chunks  first: "${first?.section}"`);
}
const report = await service.ingest();
console.log(`\nindexed ${report.chunks} chunks / ${report.tokens} tokens in ${report.durationMs}ms (${await store.count()} in store)`);

heading('3. The assembled prompt (chapter 06)');
const question = 'What is the refund window for apparel?';
const retrieval = await retriever.retrieve(question);
const prompt = buildGroundedPrompt({ question, matches: retrieval.matches, maxContextTokens: env.MAX_CONTEXT_TOKENS });
console.log(prompt.instructions);
console.log('\n--- user message ------------------------------------------');
console.log(prompt.messages.at(-1)?.content.slice(0, 700));
console.log('\n--- end ---------------------------------------------------');

heading('4. Answer with citations');
const result = await service.ask({ question, sessionId: 'demo-session' });
console.log(`Q: ${question}`);
for (const match of result.trace.matches) {
  console.log(`   ${match.score.toFixed(4)}  ${match.source} · ${match.section}`);
}
console.log(`\nA: ${result.answer}`);
console.log(
  `\ncontext=${result.trace.contextTokens} tokens  citations=${result.trace.citations}  ` +
    `invalid=${result.trace.invalidCitations}  ${result.trace.latencyMs.total}ms`,
);

heading('5. Refusal — no evidence, no model call');
const unanswered = await service.ask({ question: 'Can I pay with Bitcoin?', sessionId: 'demo-session' });
console.log(`A: ${unanswered.answer}`);
console.log(
  `refused=${unanswered.refused}  matches=${unanswered.trace.matches.length}  ` +
    `generate=${unanswered.trace.latencyMs.generate}ms`,
);

heading('6. Follow-up — the conversation resolves the reference');
const followUpSession = 'demo-followup';
await service.ask({ question: 'What is the refund window for apparel?', sessionId: followUpSession });
const followUp = await service.ask({ question: 'And for shoes?', sessionId: followUpSession });
console.log('Q: And for shoes?');
console.log(`rewritten searchQuery: ${followUp.trace.searchQuery}`);
console.log(`\nA: ${followUp.answer}`);

heading('7. The trace you would ship to your logs');
console.log(JSON.stringify(followUp.trace, null, 2));

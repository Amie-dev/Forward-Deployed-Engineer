import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pinecone } from "@pinecone-database/pinecone";
import { getEncoding } from "js-tiktoken";
import OpenAI from "openai";
import pdf from "pdf-parse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KNOWLEDGE_DIR = path.resolve(
  __dirname,
  "../spring-code/src/main/resources/knowledge",
);
const INDEX_NAME = process.env.PINECONE_INDEX_NAME ?? "shop-support";
const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "policies";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1024;
const CHAT_MODEL = "gpt-5-mini";
const CHUNK_SIZE = 300;
const TOP_K = 4;

function requireKey(name, fallbackName) {
  const value = process.env[name] ?? process.env[fallbackName];
  if (!value) {
    throw new Error(`Set ${name} (or ${fallbackName}) before running the program.`);
  }
  return value;
}

const openai = new OpenAI({
  apiKey: requireKey("OPENAI_API_KEY", "OWN_KEY"),
});
const pinecone = new Pinecone({
  apiKey: requireKey("PINECONE_API_KEY", "OWN_KEY"),
});
const pineconeIndex = pinecone.index(INDEX_NAME).namespace(NAMESPACE);
const tokenizer = getEncoding("cl100k_base");

function splitIntoTokenChunks(text, chunkSize = CHUNK_SIZE) {
  const tokens = tokenizer.encode(text);
  const chunks = [];

  for (let start = 0; start < tokens.length; start += chunkSize) {
    const chunk = tokenizer.decode(tokens.slice(start, start + chunkSize)).trim();
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

async function readKnowledgeBase() {
  const fileNames = (await readdir(KNOWLEDGE_DIR))
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();
  const chunks = [];

  for (const fileName of fileNames) {
    const filePath = path.join(KNOWLEDGE_DIR, fileName);
    const parsed = await pdf(await readFile(filePath));

    splitIntoTokenChunks(parsed.text).forEach((text, chunkNumber) => {
      chunks.push({
        text,
        metadata: { source: fileName, chunk: chunkNumber },
      });
    });
  }

  return chunks;
}

function stableId(chunk) {
  return createHash("sha256")
    .update(`${chunk.metadata.source}:${chunk.metadata.chunk}:${chunk.text}`)
    .digest("hex");
}

export async function loadKnowledgeBase() {
  const chunks = await readKnowledgeBase();
  const batchSize = 100;

  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch.map((chunk) => chunk.text),
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const records = batch.map((chunk, index) => ({
      id: stableId(chunk),
      values: embeddingResponse.data[index].embedding,
      metadata: { ...chunk.metadata, text: chunk.text },
    }));

    await pineconeIndex.upsert(records);
  }

  return chunks.length;
}

export async function answerUserQuery(question) {
  const queryEmbedding = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: question,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const searchResult = await pineconeIndex.query({
    vector: queryEmbedding.data[0].embedding,
    topK: TOP_K,
    includeMetadata: true,
  });

  const context = searchResult.matches
    .map((match) => match.metadata?.text)
    .filter(Boolean)
    .join("\n\n");

  const instructions = `You are an AI customer support assistant for our e-commerce company.

Answer the customer using ONLY the company information provided below.

If the answer is not available in the provided information, say:
"I don't have that information in the company documents."

COMPANY INFORMATION
${context}`;

  const response = await openai.responses.create({
    model: CHAT_MODEL,
    instructions,
    input: question,
  });

  return response.output_text;
}

async function main() {
  const question = process.argv.slice(2).join(" ") || "What is the return policy?";
  const chunkCount = await loadKnowledgeBase();
  console.log(`Loaded ${chunkCount} knowledge chunks.`);

  // Simple function call; no REST API or web framework is used.
  const answer = await answerUserQuery(question);
  console.log(answer);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

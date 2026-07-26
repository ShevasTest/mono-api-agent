/**
 * Пошук по індексу: гібрид векторної близькості й лексичного збігу.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { embedQuery } from "./embed.ts";
import { INDEX_PATH, type IndexedChunk, type SearchIndex } from "./index-store.ts";
import { cosineSimilarity, scoreChunk, tokenize } from "./scoring.ts";

export { formatContext } from "./scoring.ts";

export interface Hit {
  chunk: IndexedChunk;
  score: number;
}

let cached: SearchIndex | null = null;

export async function loadIndex(): Promise<SearchIndex> {
  if (cached) return cached;

  if (!existsSync(INDEX_PATH)) {
    throw new Error("індексу нема — спочатку запусти `npm run ingest`");
  }

  cached = JSON.parse(await readFile(INDEX_PATH, "utf8")) as SearchIndex;
  return cached;
}

export async function search(question: string, topK = 5): Promise<Hit[]> {
  const index = await loadIndex();
  const queryVector = await embedQuery(question);
  const queryTokens = tokenize(question);

  return index.chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, cosineSimilarity(queryVector, chunk.vector), queryTokens),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

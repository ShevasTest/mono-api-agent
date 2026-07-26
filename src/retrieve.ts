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

  let parsed: SearchIndex;
  try {
    parsed = JSON.parse(await readFile(INDEX_PATH, "utf8")) as SearchIndex;
  } catch (error) {
    // Обірваний `npm run ingest` лишає биті пів-файлу. Стек JSON.parse тут
    // нічого не пояснює людині, тому кажемо прямо, що робити.
    throw new Error(
      `індекс пошкоджено (${error instanceof Error ? error.message : error}). ` +
        "Перезбери його: npm run ingest -- --refresh",
    );
  }

  if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
    throw new Error("індекс порожній — перезбери: npm run ingest -- --refresh");
  }

  cached = parsed;
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

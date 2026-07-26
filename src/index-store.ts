/**
 * Формат індексу і шлях до нього.
 *
 * Винесено окремо від `ingest.ts` свідомо: той файл — точка входу, яка
 * виконує роботу при запуску. Якби retrieve імпортував типи звідти, кожен
 * пошук тягнув би за собою повну переіндексацію.
 */
import path from "node:path";

import type { Chunk } from "./chunk.ts";

export interface IndexedChunk extends Chunk {
  vector: number[];
}

export interface SearchIndex {
  model: string;
  dim: number;
  builtAt: string;
  chunks: IndexedChunk[];
}

export const INDEX_PATH = path.resolve("data/index.json");

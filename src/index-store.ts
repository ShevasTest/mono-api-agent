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
  /**
   * Відбитки специфікацій на момент збірки.
   *
   * Індекс — це знімок чужої документації, а monobank її оновлює. Без
   * відбитка застарілий індекс нічим не відрізняється від свіжого: агент
   * упевнено відповідає за схемою, якої вже немає.
   */
  specHashes?: Record<string, string>;
  chunks: IndexedChunk[];
}

/** Після скількох днів індекс вважається підозріло старим. */
export const STALE_AFTER_DAYS = 30;

export function indexAgeDays(index: Pick<SearchIndex, "builtAt">, now = Date.now()): number {
  const built = Date.parse(index.builtAt);
  if (Number.isNaN(built)) return Number.POSITIVE_INFINITY;
  return (now - built) / (24 * 60 * 60 * 1000);
}

export function isStale(index: Pick<SearchIndex, "builtAt">, now = Date.now()): boolean {
  return indexAgeDays(index, now) > STALE_AFTER_DAYS;
}

export const INDEX_PATH = path.resolve("data/index.json");

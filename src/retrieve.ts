/**
 * Пошук по індексу: косинусна близькість + невелика перевага ендпоїнтам.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { cosineSimilarity, embedQuery } from "./embed.ts";
import { INDEX_PATH, type IndexedChunk, type SearchIndex } from "./index-store.ts";

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

/**
 * Опис схеми окремо від ендпоїнта майже завжди менш корисний за сам ендпоїнт
 * (у ньому схема вже розкрита), тому трохи занижуємо його вагу — інакше
 * топ забивається схемами, а конкретний виклик у контекст не потрапляє.
 */
const SCHEMA_PENALTY = 0.04;

/**
 * Вага лексичного збігу в підсумковому скорі.
 *
 * Чисто векторний пошук на цьому корпусі дає дуже щільні оцінки (усе в межах
 * 0.82–0.87) — модель бачить, що всі чанки про одне й те саме платіжне API,
 * і погано їх розрізняє. Точний збіг слова на кшталт "invoice", "statement"
 * чи "webhook" — сильний сигнал, який вектор недооцінює, тож додаємо його
 * окремим доданком.
 */
const LEXICAL_WEIGHT = 0.25;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2);
}

/** Частка токенів запиту, що зустрілися в чанку. */
function lexicalScore(queryTokens: readonly string[], chunk: IndexedChunk): number {
  if (queryTokens.length === 0) return 0;

  const haystack = new Set(tokenize(`${chunk.title} ${chunk.embedText}`));
  let matched = 0;
  for (const token of queryTokens) if (haystack.has(token)) matched += 1;

  return matched / queryTokens.length;
}

export async function search(question: string, topK = 5): Promise<Hit[]> {
  const index = await loadIndex();
  const queryVector = await embedQuery(question);
  const queryTokens = tokenize(question);

  return index.chunks
    .map((chunk) => ({
      chunk,
      score:
        cosineSimilarity(queryVector, chunk.vector) +
        LEXICAL_WEIGHT * lexicalScore(queryTokens, chunk) -
        (chunk.kind === "schema" ? SCHEMA_PENALTY : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Бюджет контексту.
 *
 * Чанк ендпоїнта з повністю розкритими схемами буває під 10 000 символів,
 * і п'ять таких дають ~46 000 — це і дорого, і на моделях з меншим вікном
 * просто не влазить. Ріжемо кожен чанк і загальну суму; верхні джерела
 * важливіші, тому бюджет витрачається згори вниз.
 */
const MAX_CHUNK_CHARS = 3000;
const MAX_TOTAL_CHARS = 12_000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (обрізано, повний опис — у специфікації)`;
}

export function formatContext(hits: readonly Hit[]): string {
  const parts: string[] = [];
  let used = 0;

  for (const [i, hit] of hits.entries()) {
    if (used >= MAX_TOTAL_CHARS) break;

    const budget = Math.min(MAX_CHUNK_CHARS, MAX_TOTAL_CHARS - used);
    const body = truncate(hit.chunk.text, budget);

    parts.push(`[Джерело ${i + 1}: ${hit.chunk.title}]\n${body}`);
    used += body.length;
  }

  return parts.join("\n\n---\n\n");
}

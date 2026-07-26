/**
 * Чиста математика й форматування пошуку.
 *
 * Винесено окремо від `retrieve.ts` навмисно: там на верхньому рівні
 * імпортується transformers.js, і тест простої функції косинуса тягнув би
 * за собою півтори секунди ініціалізації ML-рантайму.
 */
import type { Chunk } from "./chunk.ts";

/**
 * Вага лексичного збігу в підсумковому скорі.
 *
 * Чисто векторний пошук на цьому корпусі дає дуже щільні оцінки (усе в межах
 * 0.82–0.87) — модель бачить, що всі чанки про одне й те саме платіжне API,
 * і погано їх розрізняє. Точний збіг слова на кшталт "invoice", "statement"
 * чи "webhook" — сильний сигнал, який вектор недооцінює.
 */
export const LEXICAL_WEIGHT = 0.25;

/**
 * Опис схеми окремо від ендпоїнта майже завжди менш корисний за сам ендпоїнт
 * (у ньому схема вже розкрита), тому трохи занижуємо його вагу — інакше
 * топ забивається схемами, а конкретний виклик у контекст не потрапляє.
 */
export const SCHEMA_PENALTY = 0.04;

/**
 * Бюджет контексту.
 *
 * Чанк ендпоїнта з повністю розкритими схемами буває під 10 000 символів,
 * і п'ять таких дають ~46 000 — це і дорого, і на моделях з меншим вікном
 * просто не влазить.
 */
export const MAX_CHUNK_CHARS = 3000;
export const MAX_TOTAL_CHARS = 12_000;

/** Вектори нормалізовані при індексації, тож косинус — це скалярний добуток. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2);
}

/** Частка токенів запиту, що зустрілися в тексті чанка. */
export function lexicalScore(queryTokens: readonly string[], haystackText: string): number {
  if (queryTokens.length === 0) return 0;

  const haystack = new Set(tokenize(haystackText));
  let matched = 0;
  for (const token of queryTokens) if (haystack.has(token)) matched += 1;

  return matched / queryTokens.length;
}

export function scoreChunk(
  chunk: Pick<Chunk, "title" | "embedText" | "kind">,
  vectorScore: number,
  queryTokens: readonly string[],
): number {
  return (
    vectorScore +
    LEXICAL_WEIGHT * lexicalScore(queryTokens, `${chunk.title} ${chunk.embedText}`) -
    (chunk.kind === "schema" ? SCHEMA_PENALTY : 0)
  );
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (обрізано, повний опис — у специфікації)`;
}

/** Збирає контекст у межах бюджету; верхні джерела важливіші, тож ідуть першими. */
export function formatContext(
  hits: ReadonlyArray<{ chunk: Pick<Chunk, "title" | "text"> }>,
): string {
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

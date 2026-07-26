/**
 * Локальні ембединги через transformers.js — модель качається один раз у
 * кеш HuggingFace і далі рахує на машині. Ні API-ключа, ні оплати, ні
 * відправлення вмісту документації на чужий сервер.
 *
 * Модель багатомовна свідомо: питання будуть українською й російською,
 * а документація — українською з англійськими назвами полів.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIM = 384;

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;

  try {
    extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
  } catch (error) {
    // Перший запуск тягне ~25 МБ з HuggingFace. Якщо мережі нема або хаб
    // недоступний, сирий стек transformers.js людині нічого не пояснює.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `не вдалося підготувати модель ембедингів ${EMBEDDING_MODEL}: ${detail}\n` +
        "Перший запуск качає ~25 МБ з huggingface.co — перевір мережу й доступ до хабу. " +
        "Модель кешується, далі інтернет уже не потрібен.",
    );
  }

  return extractor;
}

/**
 * Сімейство e5 навчене на асиметричних префіксах: індексований текст іде як
 * "passage: ", пошуковий запит — як "query: ". Без цього якість помітно гірша.
 */
function withPrefix(text: string, kind: "query" | "passage"): string {
  return `${kind}: ${text}`;
}

async function embedBatch(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
  const pipe = await getExtractor();
  const output = await pipe(
    texts.map((text) => withPrefix(text, kind)),
    { pooling: "mean", normalize: true },
  );

  const flat = Array.from(output.data as Float32Array | number[], Number);
  const dim = flat.length / texts.length;

  return texts.map((_, index) => flat.slice(index * dim, (index + 1) * dim));
}

export async function embedPassages(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const BATCH = 8;
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    vectors.push(...(await embedBatch(texts.slice(i, i + BATCH), "passage")));
    onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
  }

  return vectors;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text], "query");
  if (!vector) throw new Error("не вдалося порахувати ембединг запиту");
  return vector;
}

export { cosineSimilarity } from "./scoring.ts";

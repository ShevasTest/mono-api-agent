/**
 * Реєстр моделей і два ланцюжки фолбеку.
 *
 * Порядок не вигаданий — він виміряний `npm run bench` на двох реальних
 * задачах графа. Головне відкриття замірів: уміння тримати строгий JSON і
 * вміння дати грамотну відповідь за контекстом — РІЗНІ вміння.
 * `openrouter/free` і `gpt-oss-20b:free` відповідають добре, але JSON
 * стабільно не тримають навіть із response_format. Тому ланцюжків два:
 * модель, непридатна для маршрутизації, все ще корисна для генерації.
 */
export type ProviderName = "groq" | "openrouter";

export interface ProviderConfig {
  envKey: string;
  baseUrl: string;
}

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  groq: {
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
  },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  },
};

export interface ModelSpec {
  provider: ProviderName;
  model: string;
  /**
   * Чи приймає модель `response_format: json_object`.
   * false — параметр навіть не надсилаємо: `ling-3.0-flash` на нього
   * відповідає 400, тобто відмова, а не гірша якість.
   */
  supportsJsonMode: boolean;
  /**
   * Модель спершу «думає» вголос, і роздуми з'їдають ліміт токенів.
   *
   * Це не теорія: `nemotron-3-nano` на класифікацію з лімітом 60 витратила
   * 68 токенів на reasoning, впёрлась у стелю (finish_reason: length) і
   * повернула обрізане `{"ne`. Причому в бенчмарку вона іноді проходила —
   * коли роздуми випадково виявлялися коротшими. Такій моделі треба
   * помітно більший бюджет, інакше вона стабільно нестабільна.
   */
  reasoning: boolean;
}

interface SpecOptions {
  supportsJsonMode?: boolean;
  reasoning?: boolean;
}

const groq = (model: string, options: SpecOptions = {}): ModelSpec => ({
  provider: "groq",
  model,
  supportsJsonMode: options.supportsJsonMode ?? true,
  reasoning: options.reasoning ?? false,
});

const or = (model: string, options: SpecOptions = {}): ModelSpec => ({
  provider: "openrouter",
  model,
  supportsJsonMode: options.supportsJsonMode ?? true,
  reasoning: options.reasoning ?? false,
});

/** Мінімальний бюджет відповіді для моделі, що спершу думає вголос. */
export const REASONING_TOKEN_FLOOR = 700;

/**
 * Ланцюжок для вузлів route і verify — потрібен строгий JSON.
 * Groq стоїть першим: він помітно швидший за безкоштовні пули OpenRouter,
 * і якщо ключ дійсний, ланцюжок навіть не дійде до решти.
 */
export const JSON_CHAIN: ModelSpec[] = [
  groq("llama-3.3-70b-versatile"),
  groq("openai/gpt-oss-120b"),
  // gemma віддає рівно `{"needsLiveData": false}` за 7 токенів — для
  // класифікації це ідеал, тому серед безкоштовних вона перша.
  or("google/gemma-4-26b-a4b-it:free"),
  or("google/gemma-4-31b-it:free"),
  or("nvidia/nemotron-3-nano-30b-a3b:free", { reasoning: true }),
  or("nvidia/nemotron-3-super-120b-a12b:free", { reasoning: true }),
  or("openai/gpt-oss-20b:free", { reasoning: true }),
  or("openrouter/free"),
];

/**
 * Ланцюжок для вузла generate — потрібна якісна українська відповідь
 * за контекстом. Тут придатні всі моделі, що пройшли grounded-тест,
 * навіть ті, що провалили JSON.
 */
export const PROSE_CHAIN: ModelSpec[] = [
  groq("llama-3.3-70b-versatile"),
  groq("openai/gpt-oss-120b"),
  or("nvidia/nemotron-3-nano-30b-a3b:free", { reasoning: true }),
  or("google/gemma-4-26b-a4b-it:free"),
  or("nvidia/nemotron-3-super-120b-a12b:free", { reasoning: true }),
  or("openai/gpt-oss-20b:free", { reasoning: true }),
  or("openrouter/free"),
  or("google/gemma-4-31b-it:free"),
  or("inclusionai/ling-3.0-flash:free", { supportsJsonMode: false }),
];

export function specLabel(spec: ModelSpec): string {
  return `${spec.provider}/${spec.model}`;
}

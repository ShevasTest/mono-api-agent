/**
 * Тонкий шар між графом і транспортом до моделі.
 *
 * Тут живе політика деградації, а не механіка викликів:
 *
 *   - JSON-виклики (маршрутизація, самоперевірка) НІКОЛИ не кидають помилку.
 *     Якщо жодна модель не відповіла або відповіла сміттям, повертається
 *     безпечне значення за замовчуванням: краще піти основною гілкою графа,
 *     ніж впасти через допоміжний вузол.
 *   - Прозові виклики помилку прокидають — вузол `generate` мусить знати,
 *     що моделі нема, щоб зібрати відповідь із самої документації.
 */
import { AllModelsFailedError, extractJson, llm, type ChatOptions } from "./llm.ts";

export function isFakeMode(): boolean {
  return process.env.MONO_AGENT_FAKE_LLM === "1";
}

export interface ReasonResult {
  text: string;
  /** Яка саме модель відповіла — потрапляє у трасування. */
  via: string;
}

export async function reason(options: ChatOptions): Promise<ReasonResult> {
  if (isFakeMode()) {
    return {
      text: `[офлайн-заглушка] Модель не викликалась. У контекст потрапило ${options.user.length} символів.`,
      via: "offline-stub",
    };
  }

  const result = await llm.chat(options);
  return { text: result.text, via: `${result.spec.provider}/${result.spec.model}` };
}

export interface ReasonJsonResult<T> {
  value: T;
  via: string;
  /** true — модель не допомогла, взято значення за замовчуванням. */
  degraded: boolean;
}

export async function reasonJson<T>(
  options: ChatOptions,
  fallback: T,
): Promise<ReasonJsonResult<T>> {
  if (isFakeMode()) {
    if (process.env.MONO_AGENT_FAKE_UNGROUNDED === "1" && "grounded" in (fallback as object)) {
      return {
        value: { grounded: false, refinedQuery: "invoice create status" } as T,
        via: "offline-stub",
        degraded: false,
      };
    }
    return { value: fallback, via: "offline-stub", degraded: false };
  }

  try {
    const result = await llm.chat({ ...options, json: true, maxTokens: options.maxTokens ?? 300 });
    const parsed = extractJson<T>(result.text);

    if (parsed === undefined) {
      return { value: fallback, via: `${result.spec.provider}/${result.spec.model}`, degraded: true };
    }
    return { value: parsed, via: `${result.spec.provider}/${result.spec.model}`, degraded: false };
  } catch (error) {
    if (error instanceof AllModelsFailedError) {
      return { value: fallback, via: "—", degraded: true };
    }
    throw error;
  }
}

export { AllModelsFailedError };

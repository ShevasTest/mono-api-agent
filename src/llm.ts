/**
 * Виклик LLM з власного коду через OpenAI-сумісний клієнт.
 *
 * Провайдер визначається за тим, який ключ лежить в оточенні — так проєкт
 * запускається і на безкоштовному Groq, і на OpenRouter, і на Anthropic,
 * без правок коду.
 */
import OpenAI from "openai";

import { metrics } from "./metrics.ts";

export interface Provider {
  name: string;
  baseURL?: string;
  apiKey: string;
  model: string;
}

interface ProviderCandidate {
  name: string;
  envKey: string;
  baseURL?: string;
  defaultModel: string;
}

const CANDIDATES: ProviderCandidate[] = [
  {
    name: "groq",
    envKey: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    name: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
  },
  {
    name: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseURL: "https://api.anthropic.com/v1/",
    defaultModel: "claude-sonnet-5",
  },
  {
    name: "openai",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
  },
];

/**
 * Офлайн-режим: MONO_AGENT_FAKE_LLM=1.
 *
 * Потрібен, щобганяти й дебажити сам граф — маршрутизацію, цикл
 * retrieve → verify, збірку контексту — без ключа і без витрат. Замість
 * відповіді моделі підставляється заглушка; усе інше працює по-справжньому.
 */
export function isFakeMode(): boolean {
  return process.env.MONO_AGENT_FAKE_LLM === "1";
}

export function resolveProvider(): Provider {
  if (isFakeMode()) {
    return { name: "fake", apiKey: "-", model: "offline-stub" };
  }

  for (const candidate of CANDIDATES) {
    const apiKey = process.env[candidate.envKey];
    if (!apiKey) continue;

    return {
      name: candidate.name,
      baseURL: candidate.baseURL,
      apiKey,
      model: process.env.MONO_AGENT_MODEL ?? candidate.defaultModel,
    };
  }

  throw new Error(
    `нема жодного ключа в оточенні. Постав один із: ${CANDIDATES.map((c) => c.envKey).join(", ")}\n` +
      "Наприклад: cp .env.example .env і впиши ключ туди.",
  );
}

let client: OpenAI | null = null;
let provider: Provider | null = null;

function getClient(): { client: OpenAI; provider: Provider } {
  if (!client || !provider) {
    provider = resolveProvider();
    client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  }
  return { client, provider };
}

export interface ChatOptions {
  system: string;
  user: string;
  /** Низька температура: завдання — точність по документації, не творчість. */
  temperature?: number;
  maxTokens?: number;
}

export async function chat({
  system,
  user,
  temperature = 0.1,
  maxTokens = 1200,
}: ChatOptions): Promise<string> {
  if (isFakeMode()) {
    return `[офлайн-заглушка] Модель не викликалась. У контекст потрапило ${user.length} символів.`;
  }

  const { client: openai, provider: active } = getClient();

  const started = Date.now();
  const completion = await openai.chat.completions.create({
    model: active.model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  metrics.recordCall({
    model: active.model,
    promptTokens: completion.usage?.prompt_tokens ?? 0,
    completionTokens: completion.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - started,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

/** Просить модель повернути JSON і толерантно його парсить. */
export async function chatJson<T>(options: ChatOptions, fallback: T): Promise<T> {
  // У офлайн-режимі класифікатор і верифікатор просто беруть fallback,
  // тобто граф іде основною гілкою: documentation → retrieve → generate → END.
  // MONO_AGENT_FAKE_UNGROUNDED=1 змушує верифікатор сказати "контексту бракує" —
  // так перевіряється, що цикл retrieve → generate → verify справді замикається.
  if (isFakeMode()) {
    if (process.env.MONO_AGENT_FAKE_UNGROUNDED === "1" && "grounded" in (fallback as object)) {
      return { grounded: false, refinedQuery: "invoice create status" } as T;
    }
    return fallback;
  }

  const raw = await chat({ ...options, maxTokens: options.maxTokens ?? 300 });

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;

  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return fallback;
  }
}

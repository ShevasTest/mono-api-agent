/**
 * Виклик LLM із багаторівневим фолбеком.
 *
 * Задача: відповідь має бути завжди. Безкоштовні пули OpenRouter регулярно
 * віддають 429, провайдер може лежати, ключ може виявитись недійсним —
 * жодна з цих подій не повинна дійти до користувача як «немає відповіді».
 *
 * Тому помилки не звалені в одну купу, а розрізняються по суті:
 *
 *   401/403  ключ недійсний    → провайдер вимикається на весь процес.
 *                                Повторювати безглуздо, а кожна спроба —
 *                                це втрачені секунди на решті ланцюжка.
 *   404      моделі нема       → вимикається саме ця модель, назавжди.
 *   400      запит не прийнято → якщо просили JSON-режим, пробуємо ще раз
 *                                без нього (частина моделей його не вміє
 *                                і відповідає саме 400), інакше — далі.
 *   429      ліміт             → чекаємо (з повагою до Retry-After) і
 *                                пробуємо ще раз, потім розмикаємо запобіжник.
 *   5xx/мережа/таймаут         → транзієнт, повтор із експоненційною паузою.
 *   порожня відповідь          → як транзієнт: модель відповіла, але нічим.
 *
 * Понад це є загальний дедлайн на всю операцію: ланцюжок із дев'яти моделей
 * із повторами в найгіршому випадку тривав би хвилини, а користувач стільки
 * не чекатиме.
 */
import { metrics } from "./metrics.ts";
import {
  JSON_CHAIN,
  PROSE_CHAIN,
  PROVIDERS,
  REASONING_TOKEN_FLOOR,
  specLabel,
  type ModelSpec,
  type ProviderName,
} from "./providers.ts";

export type FailureKind =
  | "auth"
  | "model_missing"
  | "bad_request"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "empty"
  | "truncated";

export interface AttemptLog {
  spec: string;
  kind: FailureKind;
  status?: number;
  detail: string;
  ms: number;
}

export class AllModelsFailedError extends Error {
  constructor(readonly attempts: readonly AttemptLog[]) {
    super(
      `жодна модель не відповіла (${attempts.length} спроб): ` +
        attempts.map((a) => `${a.spec} → ${a.kind}`).join("; "),
    );
    this.name = "AllModelsFailedError";
  }
}

export interface LlmConfig {
  /** Скільки разів пробувати одну модель, перш ніж іти до наступної. */
  attemptsPerModel: number;
  /** Базова пауза для експоненційного відкату, мс. */
  backoffBaseMs: number;
  /** Стеля паузи, мс. */
  backoffMaxMs: number;
  /** Таймаут одного HTTP-запиту, мс. */
  requestTimeoutMs: number;
  /** Загальний бюджет на всю операцію, мс. */
  totalDeadlineMs: number;
  /** Скільки поспіль невдач розмикають запобіжник моделі. */
  breakerThreshold: number;
  /** Наскільки запобіжник лишається розімкненим, мс. */
  breakerCooldownMs: number;
}

export const DEFAULT_CONFIG: LlmConfig = {
  attemptsPerModel: 2,
  backoffBaseMs: 400,
  backoffMaxMs: 4000,
  requestTimeoutMs: 45_000,
  totalDeadlineMs: 120_000,
  breakerThreshold: 2,
  breakerCooldownMs: 60_000,
};

export interface LlmDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
  random: () => number;
}

export interface ChatOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** Вимагати від моделі строгий JSON. */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  spec: ModelSpec;
  attempts: AttemptLog[];
}

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

/** Витягує число секунд із Retry-After (підтримується лише формат «секунди»). */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function classifyStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model_missing";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

export class LlmClient {
  private readonly config: LlmConfig;
  private readonly deps: LlmDeps;

  private readonly breakers = new Map<string, BreakerState>();
  private readonly disabledProviders = new Set<ProviderName>();
  private readonly disabledModels = new Set<string>();
  /** Моделі, яким довелося вимкнути JSON-режим через 400. */
  private readonly jsonModeDenied = new Set<string>();

  constructor(deps: Partial<LlmDeps> = {}, config: Partial<LlmConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      env: deps.env ?? process.env,
      random: deps.random ?? Math.random,
    };
  }

  /** Скидає накопичений стан — потрібно тестам і довгоживучим процесам. */
  reset() {
    this.breakers.clear();
    this.disabledProviders.clear();
    this.disabledModels.clear();
    this.jsonModeDenied.clear();
  }

  /** Чи є хоч один ключ, тобто чи взагалі можна кудись піти. */
  hasAnyKey(): boolean {
    return Object.values(PROVIDERS).some((p) => Boolean(this.deps.env[p.envKey]));
  }

  availableModels(chain: readonly ModelSpec[]): ModelSpec[] {
    const now = this.deps.now();
    return chain.filter((spec) => {
      if (this.disabledProviders.has(spec.provider)) return false;
      if (this.disabledModels.has(specLabel(spec))) return false;
      if (!this.deps.env[PROVIDERS[spec.provider].envKey]) return false;

      const breaker = this.breakers.get(specLabel(spec));
      return !breaker || breaker.openUntil <= now;
    });
  }

  private noteFailure(spec: ModelSpec) {
    const label = specLabel(spec);
    const breaker = this.breakers.get(label) ?? { consecutiveFailures: 0, openUntil: 0 };
    breaker.consecutiveFailures += 1;

    if (breaker.consecutiveFailures >= this.config.breakerThreshold) {
      breaker.openUntil = this.deps.now() + this.config.breakerCooldownMs;
    }
    this.breakers.set(label, breaker);
  }

  private noteSuccess(spec: ModelSpec) {
    this.breakers.set(specLabel(spec), { consecutiveFailures: 0, openUntil: 0 });
  }

  /** Пауза з експоненційним ростом і джитером — щоб не бити пачкою в ту саму секунду. */
  private backoffFor(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.config.backoffMaxMs);
    }
    const exponential = this.config.backoffBaseMs * 2 ** attempt;
    const jitter = 1 + this.deps.random() * 0.3;
    return Math.min(Math.round(exponential * jitter), this.config.backoffMaxMs);
  }

  /**
   * Скільки токенів дати моделі на відповідь.
   *
   * Reasoning-моделі витрачають частину бюджету на роздуми, які в контент
   * не потрапляють. Дати їй той самий ліміт, що й звичайній, — це гарантовано
   * отримати обрізаний результат.
   */
  private budgetFor(spec: ModelSpec, requested: number, retryBoost: number): number {
    const base = spec.reasoning ? Math.max(requested, REASONING_TOKEN_FLOOR) : requested;
    return base * retryBoost;
  }

  private async callOnce(
    spec: ModelSpec,
    options: ChatOptions,
    useJsonMode: boolean,
    maxTokens: number,
    expectJson: boolean,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
    const provider = PROVIDERS[spec.provider];
    const apiKey = this.deps.env[provider.envKey];
    if (!apiKey) {
      throw Object.assign(new Error("нема ключа"), { kind: "auth" as FailureKind });
    }

    const response = await this.deps.fetch(provider.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: spec.model,
        temperature: options.temperature ?? 0.1,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
        ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw Object.assign(new Error(`HTTP ${response.status} ${body.slice(0, 160)}`), {
        kind: classifyStatus(response.status),
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers?.get?.("retry-after") ?? null),
      });
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = data.choices?.[0];
    const text = choice?.message?.content?.trim() ?? "";

    if (!text) {
      throw Object.assign(new Error("порожня відповідь"), { kind: "empty" as FailureKind });
    }

    // Обрив по ліміту токенів зазвичай означає зіпсовану відповідь: для
    // прози — речення, обірване на півслові.
    //
    // Але не завжди. `llama-3.1-8b-instant` віддає валідний
    // `{\n  "needsLiveData": false\n}` і впирається в стелю рівно на
    // закривальній дужці — форматування з переносами з'їдає останні токени.
    // Перша версія цієї перевірки викидала такий цілком придатний результат
    // і йшла до наступної моделі, втрачаючи сім разів по швидкості.
    // Тому для JSON вирішує не finish_reason, а те, чи розбирається відповідь.
    if (choice?.finish_reason === "length") {
      const salvageable = expectJson && extractJson(text) !== undefined;
      if (!salvageable) {
        throw Object.assign(new Error("відповідь обрізано по ліміту токенів"), {
          kind: "truncated" as FailureKind,
        });
      }
    }

    return {
      text,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    };
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const chain = options.json ? JSON_CHAIN : PROSE_CHAIN;
    const attempts: AttemptLog[] = [];
    const deadline = this.deps.now() + this.config.totalDeadlineMs;

    for (const spec of this.availableModels(chain)) {
      const label = specLabel(spec);

      // Список доступних моделей знято на початку, але під час проходу
      // ланцюжка стан міг змінитись: 401 від першої моделі провайдера
      // вимикає провайдера цілком, і решту його моделей чіпати вже не можна.
      if (this.disabledProviders.has(spec.provider) || this.disabledModels.has(label)) continue;
      // Множник бюджету токенів: після обриву по ліміту повторюємо ту саму
      // модель, але вже з ширшим запасом.
      let retryBoost = 1;

      for (let attempt = 0; attempt < this.config.attemptsPerModel; attempt += 1) {
        if (this.deps.now() >= deadline) {
          attempts.push({ spec: label, kind: "timeout", detail: "вичерпано бюджет", ms: 0 });
          return this.fail(attempts);
        }

        const useJsonMode =
          Boolean(options.json) && spec.supportsJsonMode && !this.jsonModeDenied.has(label);

        const started = this.deps.now();
        try {
          const result = await this.callOnce(
            spec,
            options,
            useJsonMode,
            this.budgetFor(spec, options.maxTokens ?? 1200, retryBoost),
            Boolean(options.json),
          );

          metrics.recordCall({
            model: label,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            durationMs: this.deps.now() - started,
          });

          this.noteSuccess(spec);
          return { text: result.text, spec, attempts };
        } catch (error) {
          const kind = (error as { kind?: FailureKind }).kind ?? this.kindFromThrown(error);
          const status = (error as { status?: number }).status;
          const detail = error instanceof Error ? error.message : String(error);

          attempts.push({ spec: label, kind, status, detail, ms: this.deps.now() - started });

          // Помилки, після яких повторювати цю модель безглуздо.
          if (kind === "auth") {
            this.disabledProviders.add(spec.provider);
            break;
          }
          if (kind === "model_missing") {
            this.disabledModels.add(label);
            break;
          }
          if (kind === "bad_request") {
            // Найчастіша причина — модель не вміє response_format.
            // Знімаємо JSON-режим і даємо їй ще один шанс.
            if (useJsonMode && !this.jsonModeDenied.has(label)) {
              this.jsonModeDenied.add(label);
              continue;
            }
            this.disabledModels.add(label);
            break;
          }
          if (kind === "truncated") {
            // Повторювати з тим самим бюджетом безглуздо — обріже знову.
            retryBoost *= 4;
          }

          this.noteFailure(spec);

          const isLastAttempt = attempt === this.config.attemptsPerModel - 1;
          if (isLastAttempt) break;

          await this.deps.sleep(
            this.backoffFor(attempt, (error as { retryAfterMs?: number }).retryAfterMs),
          );
        }
      }
    }

    return this.fail(attempts);
  }

  private kindFromThrown(error: unknown): FailureKind {
    const name = (error as { name?: string })?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    return "network";
  }

  private fail(attempts: AttemptLog[]): never {
    throw new AllModelsFailedError(attempts);
  }
}

/** Клієнт за замовчуванням для звичайного запуску. */
export const llm = new LlmClient();

/**
 * Витягує JSON з відповіді моделі.
 *
 * Толерантний свідомо: навіть із response_format частина моделей обгортає
 * результат у ```json-огорожу або додає рядок пояснення. Вимагати ідеалу
 * означало б без потреби відкидати придатні відповіді.
 */
export function extractJson<T>(raw: string): T | undefined {
  const withoutFence = raw.replace(/```(?:json)?/gi, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(withoutFence.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

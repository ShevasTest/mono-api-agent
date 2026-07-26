/**
 * Виклик LLM із багаторівневим фолбеком.
 *
 * Задача: відповідь має бути завжди. Безкоштовні пули OpenRouter регулярно
 * віддають 429, провайдер може лежати, ключ може виявитись недійсним —
 * жодна з цих подій не повинна дійти до користувача як «немає відповіді».
 *
 * Тому помилки не звалені в одну купу, а розрізняються по суті:
 *
 *   auth (401/403)     ключ недійсний  → вимикається САМЕ ЦЕЙ КЛЮЧ, а не
 *                                        провайдер: решта його ключів має
 *                                        право спробувати.
 *   model_missing (404)                → вимикається саме ця модель.
 *   bad_request (400)                  → якщо просили JSON-режим, пробуємо
 *                                        ще раз без нього (частина моделей
 *                                        його не вміє), інакше — далі.
 *   context_overflow (400 з ознаками)  → винен розмір нашого запиту, а не
 *                                        модель: стискаємо і повторюємо на
 *                                        ТІЙ САМІЙ моделі.
 *   rate_limit (429)                   → миттєвий сплеск: пауза з повагою
 *                                        до Retry-After, потім повтор.
 *   quota_exhausted (429 з ознаками)   → денна квота ключа. Вона вбиває всі
 *                                        моделі цього ключа, тож гасимо
 *                                        ключ цілком і надовго.
 *   server (5xx), network, timeout     → транзієнт, експоненційний відкат.
 *   empty                              → модель відповіла, але нічим.
 *   truncated                          → обрив по ліміту токенів; повтор із
 *                                        ширшим бюджетом, а текст лишаємо
 *                                        як запасний варіант.
 *
 * Понад це є загальний дедлайн на всю операцію: ланцюжок моделей із
 * повторами в найгіршому випадку тривав би хвилини, а користувач стільки
 * не чекатиме. І останній рубіж: якщо цілої відповіді не дала жодна модель,
 * повертається найповніша обрізана, а не помилка.
 */
import { metrics } from "./metrics.ts";
import {
  JSON_CHAIN,
  PROSE_CHAIN,
  PROVIDERS,
  REASONING_TOKEN_FLOOR,
  specLabel,
  resolveKeys,
  keyId,
  type ApiKey,
  type ModelSpec,
  type ProviderName,
} from "./providers.ts";

export type FailureKind =
  | "auth"
  | "model_missing"
  | "bad_request"
  | "rate_limit"
  | "quota_exhausted"
  | "context_overflow"
  | "server"
  | "network"
  | "timeout"
  | "empty"
  | "truncated";

/**
 * Ознаки того, що провайдер відмовив саме через завеликий вхід.
 *
 * Це принципово інша ситуація, ніж «модель зламана»: тут винен не провайдер,
 * а наш запит, і лікується вона стисканням контексту, а не переходом до
 * наступної моделі. Формулювання в різних провайдерів різні, тому шукаємо
 * за набором ознак.
 */
const CONTEXT_OVERFLOW_HINTS = [
  "context length",
  "context_length",
  "context window",
  "maximum context",
  "too many tokens",
  "reduce the length",
  "input is too long",
  "prompt is too long",
  "request too large",
];

/** Ознаки вичерпаної денної/місячної квоти, а не миттєвого сплеску. */
const QUOTA_HINTS = ["per-day", "per day", "daily limit", "quota", "credits", "monthly"];

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

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
  /** Вистигання для вичерпаної денної квоти — воно значно довше. */
  quotaCooldownMs: number;
}

export const DEFAULT_CONFIG: LlmConfig = {
  attemptsPerModel: 2,
  backoffBaseMs: 400,
  backoffMaxMs: 4000,
  requestTimeoutMs: 45_000,
  totalDeadlineMs: 120_000,
  breakerThreshold: 2,
  breakerCooldownMs: 60_000,
  quotaCooldownMs: 6 * 60 * 60 * 1000,
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
  /** true — жодна модель не дала цілої відповіді, віддано найповнішу обрізану. */
  truncated?: boolean;
}

/** Стеля нарощування бюджету токенів — за нею почнеться 400 від самої моделі. */
export const MAX_RETRY_BOOST = 8;

/** Скільки разів поспіль стискати контекст, перш ніж визнати модель непридатною. */
export const MAX_SHRINK_LEVEL = 2;

/** На кожному рівні стискання лишаємо цю частку тексту. */
const SHRINK_RATIO = 0.5;

/**
 * Стискає користувацьку частину запиту при переповненні контексту.
 *
 * Ріжемо з середини, а не з кінця: на початку — найрелевантніші джерела,
 * а в самому кінці — питання користувача, без якого запит безглуздий.
 */
export function shrinkOptions(options: ChatOptions, level: number): ChatOptions {
  const keepRatio = SHRINK_RATIO ** level;
  const target = Math.max(500, Math.floor(options.user.length * keepRatio));
  if (options.user.length <= target) return options;

  const headSize = Math.floor(target * 0.7);
  const tailSize = target - headSize;

  const head = options.user.slice(0, headSize);
  const tail = options.user.slice(options.user.length - tailSize);

  return {
    ...options,
    user: `${head}\n\n… (контекст скорочено, щоб уміститись у вікно моделі) …\n\n${tail}`,
  };
}

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

/**
 * Витягує паузу з Retry-After.
 *
 * RFC 9110 дозволяє два формати: число секунд і HTTP-дату. Перша версія
 * розуміла лише перший, і на даті мовчки повертала undefined — тобто ми
 * ігнорували пряму вказівку сервера, коли він її давав.
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;

  const trimmed = header.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;

  return Math.max(0, at - now);
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
  private readonly disabledModels = new Set<string>();
  /** Моделі, яким довелося вимкнути JSON-режим через 400. */
  private readonly jsonModeDenied = new Set<string>();

  /**
   * Стан окремих ключів, а не провайдерів цілком.
   *
   * Раніше 401 вимикав провайдера повністю — з одним ключем це те саме, але
   * з кількома означало б викинути справні ключі через один зіпсований.
   */
  private readonly deadKeys = new Set<string>();
  private readonly keyCooldowns = new Map<string, number>();

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
    this.disabledModels.clear();
    this.jsonModeDenied.clear();
    this.deadKeys.clear();
    this.keyCooldowns.clear();
  }

  /** Усі налаштовані ключі провайдера, придатні до використання зараз. */
  availableKeys(provider: ProviderName): ApiKey[] {
    const now = this.deps.now();
    return resolveKeys(provider, this.deps.env).filter((key) => {
      const id = keyId(key);
      if (this.deadKeys.has(id)) return false;
      return (this.keyCooldowns.get(id) ?? 0) <= now;
    });
  }

  /** Скільки ключів налаштовано взагалі, незалежно від їхнього стану. */
  configuredKeyCount(): number {
    return (Object.keys(PROVIDERS) as ProviderName[]).reduce(
      (sum, provider) => sum + resolveKeys(provider, this.deps.env).length,
      0,
    );
  }

  hasAnyKey(): boolean {
    return this.configuredKeyCount() > 0;
  }

  availableModels(chain: readonly ModelSpec[]): ModelSpec[] {
    const now = this.deps.now();
    return chain.filter((spec) => {
      if (this.disabledModels.has(specLabel(spec))) return false;
      if (this.availableKeys(spec.provider).length === 0) return false;

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
    apiKey: ApiKey,
    options: ChatOptions,
    useJsonMode: boolean,
    maxTokens: number,
    expectJson: boolean,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
    const provider = PROVIDERS[spec.provider];

    const response = await this.deps.fetch(provider.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey.value}`,
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

      // Тіло відповіді уточнює діагноз там, де код статусу занадто грубий:
      // 400 буває і «модель не вміє json», і «ти надіслав забагато тексту»,
      // а 429 — і миттєвий сплеск, і вичерпана денна квота.
      let kind = classifyStatus(response.status);
      if (kind === "bad_request" && matchesAny(body, CONTEXT_OVERFLOW_HINTS)) {
        kind = "context_overflow";
      } else if (kind === "rate_limit" && matchesAny(body, QUOTA_HINTS)) {
        kind = "quota_exhausted";
      }

      throw Object.assign(new Error(`HTTP ${response.status} ${body.slice(0, 160)}`), {
        kind,
        status: response.status,
        retryAfterMs: parseRetryAfter(
          response.headers?.get?.("retry-after") ?? null,
          this.deps.now(),
        ),
      });
    }

    let data: {
      choices?: Array<{
        message?: { content?: string; reasoning?: string };
        finish_reason?: string;
      }>;
      error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    try {
      data = (await response.json()) as typeof data;
    } catch {
      // Буває: проксі віддав 200 з HTML-заглушкою замість JSON.
      throw Object.assign(new Error("відповідь не є JSON"), { kind: "empty" as FailureKind });
    }

    // Частина провайдерів OpenRouter повертає помилку зі статусом 200,
    // сховавши її в тіло. Без цієї перевірки вона виглядала б як порожня
    // відповідь і з'їдала б обидві спроби моделі.
    if (data.error?.message && !data.choices?.length) {
      const message = data.error.message;
      throw Object.assign(new Error(`помилка в тілі 200: ${message.slice(0, 160)}`), {
        kind: matchesAny(message, CONTEXT_OVERFLOW_HINTS)
          ? ("context_overflow" as FailureKind)
          : ("server" as FailureKind),
      });
    }

    const choice = data.choices?.[0];

    // Reasoning-моделі іноді вивалюють усе в поле roздумів і лишають content
    // порожнім. Викидати таку відповідь шкода — там може бути готовий результат.
    const text = (choice?.message?.content?.trim() || choice?.message?.reasoning?.trim()) ?? "";

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
        // Текст усе одно передаємо: якщо жодна модель не дасть цілої
        // відповіді, обрізана — усе ще краще за дамп документації.
        throw Object.assign(new Error("відповідь обрізано по ліміту токенів"), {
          kind: "truncated" as FailureKind,
          partialText: text,
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

    /**
     * Найкраще, що вдалося отримати, навіть якщо воно неідеальне.
     * Обрізана на 90% відповідь — це все одно відповідь, і вона незрівнянно
     * корисніша за дамп специфікації, до якого граф падає в самому кінці.
     */
    let bestEffort: { text: string; spec: ModelSpec } | undefined;

    for (const spec of this.availableModels(chain)) {
      const label = specLabel(spec);
      if (this.disabledModels.has(label)) continue;

      // Ключі перебираються всередині моделі, а не зовні. Причина: денна
      // квота OpenRouter вичерпується на ключ і одразу на всі безкоштовні
      // моделі. Якби ключ мінявся лише на наступній моделі, ми б спалили
      // решту ланцюжка на тому самому вичерпаному ключі.
      let handled = false;

      for (const apiKey of this.availableKeys(spec.provider)) {
        if (handled || this.disabledModels.has(label)) break;

        const id = keyId(apiKey);
        // Множник бюджету токенів: після обриву повторюємо ту саму модель,
        // але вже з ширшим запасом.
        let retryBoost = 1;
        // Скільки разів довелося стиснути контекст.
        let shrinkLevel = 0;

        for (let attempt = 0; attempt < this.config.attemptsPerModel + shrinkLevel; attempt += 1) {
          if (this.deps.now() >= deadline) {
            attempts.push({ spec: label, kind: "timeout", detail: "вичерпано бюджет", ms: 0 });
            return this.finish(attempts, bestEffort);
          }

          const useJsonMode =
            Boolean(options.json) && spec.supportsJsonMode && !this.jsonModeDenied.has(label);

          const started = this.deps.now();
          try {
            const result = await this.callOnce(
              spec,
              apiKey,
              shrinkLevel > 0 ? shrinkOptions(options, shrinkLevel) : options,
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

            attempts.push({
              spec: `${label} [${apiKey.source}]`,
              kind,
              status,
              detail,
              ms: this.deps.now() - started,
            });

            // Обрізану відповідь запам'ятовуємо як запасний варіант — раптом
            // цілої не дасть ніхто. Довша обрізана краща за коротшу.
            const partial = (error as { partialText?: string }).partialText;
            if (partial && partial.length > (bestEffort?.text.length ?? 0)) {
              bestEffort = { text: partial, spec };
            }

            if (kind === "auth") {
              // Зіпсований ключ, а не зіпсований провайдер: решта ключів
              // цього провайдера має право спробувати.
              this.deadKeys.add(id);
              break;
            }
            if (kind === "quota_exhausted") {
              // Квота прив'язана до облікового запису, тож вона вбиває всі
              // моделі цього ключа, а не одну. Гасимо ключ цілком і йдемо
              // на наступний — саме заради цього і потрібен другий ключ.
              this.keyCooldowns.set(id, this.deps.now() + this.config.quotaCooldownMs);
              break;
            }
            if (kind === "model_missing") {
              this.disabledModels.add(label);
              handled = true;
              break;
            }
            if (kind === "context_overflow") {
              if (shrinkLevel < MAX_SHRINK_LEVEL) {
                shrinkLevel += 1;
                continue;
              }
              this.disabledModels.add(label);
              handled = true;
              break;
            }
            if (kind === "bad_request") {
              if (useJsonMode && !this.jsonModeDenied.has(label)) {
                this.jsonModeDenied.add(label);
                continue;
              }
              this.disabledModels.add(label);
              handled = true;
              break;
            }
            if (kind === "truncated") {
              retryBoost = Math.min(retryBoost * 4, MAX_RETRY_BOOST);
            }

            this.noteFailure(spec);

            if (attempt === this.config.attemptsPerModel + shrinkLevel - 1) break;

            await this.deps.sleep(
              this.backoffFor(attempt, (error as { retryAfterMs?: number }).retryAfterMs),
            );
          }
        }
      }
    }

    return this.finish(attempts, bestEffort);
  }

  private kindFromThrown(error: unknown): FailureKind {
    const name = (error as { name?: string })?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    return "network";
  }

  /** Або віддає найкраще з наявного, або визнає повний провал. */
  private finish(
    attempts: AttemptLog[],
    bestEffort?: { text: string; spec: ModelSpec },
  ): ChatResult {
    if (bestEffort) {
      return { text: bestEffort.text, spec: bestEffort.spec, attempts, truncated: true };
    }
    throw new AllModelsFailedError(attempts);
  }
}

/** Клієнт за замовчуванням для звичайного запуску. */
export const llm = new LlmClient();

/**
 * Прибирає блоки роздумів reasoning-моделей.
 *
 * Критично для розбору JSON: у роздумах майже завжди є фігурні дужки
 * («потрібно повернути {"needsLiveData": false}»), і наївний пошук від першої
 * дужки до останньої захоплював обидва фрагменти разом, після чого падав
 * увесь розбір — при цілком коректній відповіді поруч.
 */
export function stripReasoning(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, " ")
    // Незакритий блок: модель почала думати й обірвалась по ліміту токенів.
    .replace(/<think(?:ing)?>[\s\S]*$/i, " ");
}

/** Знаходить перший збалансований JSON-об'єкт, поважаючи рядки й екранування. */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return undefined;
}

/**
 * Витягує JSON з відповіді моделі.
 *
 * Толерантний свідомо: навіть із response_format частина моделей обгортає
 * результат у ```json-огорожу, додає рядок пояснення або блок роздумів.
 * Вимагати ідеалу означало б без потреби відкидати придатні відповіді.
 */
export function extractJson<T>(raw: string): T | undefined {
  const cleaned = stripReasoning(raw).replace(/```(?:json)?/gi, "");

  // Спершу перший збалансований об'єкт — він переживає і сторонній текст
  // після себе, і другий об'єкт поруч.
  const balanced = firstBalancedObject(cleaned);
  if (balanced) {
    try {
      return JSON.parse(balanced) as T;
    } catch {
      /* спробуємо ширший захват нижче */
    }
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

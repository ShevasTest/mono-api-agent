/**
 * Живий інструмент агента: публічний ендпоїнт курсів monobank.
 *
 * Обраний свідомо — це єдиний метод API, який не потребує токена, тож демо
 * запускається в будь-кого без реєстрації мерчанта. Агент викликає його лише
 * тоді, коли питання справді про поточний курс, а не про документацію.
 */
export const CURRENCY_URL = "https://api.monobank.ua/bank/currency";

/** ISO 4217 → літерний код, лише те, що реально потрібно для відповіді. */
const CURRENCY_CODES: Record<number, string> = {
  840: "USD",
  978: "EUR",
  980: "UAH",
  985: "PLN",
  826: "GBP",
  756: "CHF",
  203: "CZK",
};

const UAH = 980;

export interface CurrencyRate {
  currencyCodeA: number;
  currencyCodeB: number;
  date: number;
  rateBuy?: number;
  rateSell?: number;
  rateCross?: number;
}

/** monobank жорстко лімітує цей ендпоїнт (1 запит / 60 с), тому кешуємо. */
export const CACHE_TTL_MS = 60_000;

export interface CurrencyDeps {
  fetch: typeof fetch;
  now: () => number;
}

export function formatRates(rates: readonly CurrencyRate[]): string {
  const lines = rates
    .filter((rate) => CURRENCY_CODES[rate.currencyCodeA] && rate.currencyCodeB === UAH)
    .map((rate) => {
      const code = CURRENCY_CODES[rate.currencyCodeA];
      const parts: string[] = [];
      if (rate.rateBuy) parts.push(`купівля ${rate.rateBuy}`);
      if (rate.rateSell) parts.push(`продаж ${rate.rateSell}`);
      if (parts.length === 0 && rate.rateCross) parts.push(`крос-курс ${rate.rateCross}`);
      if (parts.length === 0) return null;

      const at = new Date(rate.date * 1000).toISOString().replace("T", " ").slice(0, 16);
      return `${code}/UAH — ${parts.join(", ")} (оновлено ${at} UTC)`;
    })
    .filter((line): line is string => line !== null);

  return lines.length
    ? `Актуальні курси monobank (${CURRENCY_URL}):\n${lines.join("\n")}`
    : "ендпоїнт відповів, але потрібних валют у відповіді не знайшлось";
}

export class CurrencyTool {
  private cache: { at: number; text: string } | null = null;
  private readonly deps: CurrencyDeps;

  constructor(deps: Partial<CurrencyDeps> = {}) {
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now ?? (() => Date.now()),
    };
  }

  clearCache() {
    this.cache = null;
  }

  async getRates(): Promise<string> {
    if (this.cache && this.deps.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.text;
    }

    let response: Response;
    try {
      response = await this.deps.fetch(CURRENCY_URL, {
        headers: { "user-agent": "mono-api-agent" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Інструмент не має права впасти й забрати з собою весь граф:
      // без курсів відповідь усе одно буде зібрана з документації.
      return `не вдалося зв'язатися з API курсів: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    if (response.status === 429) {
      return "monobank віддав 429: ліміт — один запит на 60 секунд. Спробуй за хвилину.";
    }
    if (!response.ok) {
      return `не вдалося отримати курси: HTTP ${response.status}`;
    }

    let rates: CurrencyRate[];
    try {
      rates = (await response.json()) as CurrencyRate[];
    } catch {
      return "API курсів повернуло не JSON";
    }

    if (!Array.isArray(rates)) return "API курсів повернуло несподіваний формат";

    const text = formatRates(rates);
    this.cache = { at: this.deps.now(), text };
    return text;
  }
}

const defaultTool = new CurrencyTool();

export function getCurrencyRates(): Promise<string> {
  return defaultTool.getRates();
}

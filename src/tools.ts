/**
 * Живий інструмент агента: публічний ендпоїнт курсів monobank.
 *
 * Обраний свідомо — це єдиний метод API, який не потребує токена, тож демо
 * запускається в будь-кого без реєстрації мерчанта. Агент викликає його лише
 * тоді, коли питання справді про поточний курс, а не про документацію.
 */
const CURRENCY_URL = "https://api.monobank.ua/bank/currency";

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

interface CurrencyRate {
  currencyCodeA: number;
  currencyCodeB: number;
  date: number;
  rateBuy?: number;
  rateSell?: number;
  rateCross?: number;
}

/** monobank жорстко лімітує цей ендпоїнт (1 запит / 60 с), тому кешуємо. */
const CACHE_TTL_MS = 60_000;
let cache: { at: number; text: string } | null = null;

export async function getCurrencyRates(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.text;

  const response = await fetch(CURRENCY_URL, {
    headers: { "user-agent": "mono-api-agent" },
  });

  if (response.status === 429) {
    return "monobank віддав 429: ліміт — один запит на 60 секунд. Спробуй за хвилину.";
  }
  if (!response.ok) {
    return `не вдалося отримати курси: HTTP ${response.status}`;
  }

  const rates = (await response.json()) as CurrencyRate[];

  const lines = rates
    .filter((rate) => CURRENCY_CODES[rate.currencyCodeA] && rate.currencyCodeB === 980)
    .map((rate) => {
      const code = CURRENCY_CODES[rate.currencyCodeA];
      const parts: string[] = [];
      if (rate.rateBuy) parts.push(`купівля ${rate.rateBuy}`);
      if (rate.rateSell) parts.push(`продаж ${rate.rateSell}`);
      if (!parts.length && rate.rateCross) parts.push(`крос-курс ${rate.rateCross}`);
      const at = new Date(rate.date * 1000).toISOString().replace("T", " ").slice(0, 16);
      return `${code}/UAH — ${parts.join(", ")} (оновлено ${at} UTC)`;
    });

  const text = lines.length
    ? `Актуальні курси monobank (${CURRENCY_URL}):\n${lines.join("\n")}`
    : "ендпоїнт відповів, але потрібних валют у відповіді не знайшлось";

  cache = { at: Date.now(), text };
  return text;
}

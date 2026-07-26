/**
 * Бенчмарк моделей-кандидатів: npm run bench
 *
 * Порядок у ланцюжку фолбеку не вигаданий — він узятий із замірів цим
 * скриптом. Перевіряються рівно ті два вміння, які потрібні графу:
 *
 *   1) JSON — вузли route і verify вимагають строгий JSON. Модель, яка
 *      обгортає його в пояснення або markdown, ламає маршрутизацію.
 *   2) Grounded — відповідь виключно за наданим контекстом, українською,
 *      без вигаданих полів.
 *
 * Скрипт свідомо не використовує llm.ts: він міряє самі моделі, а не
 * обгортку над ними.
 */
import { loadDotEnv } from "./env.ts";

interface Candidate {
  provider: "groq" | "openrouter";
  model: string;
}

const CANDIDATES: Candidate[] = [
  { provider: "groq", model: "llama-3.3-70b-versatile" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "qwen/qwen3.6-27b" },
  { provider: "groq", model: "llama-3.1-8b-instant" },
  { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
  { provider: "openrouter", model: "google/gemma-4-31b-it:free" },
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "openai/gpt-oss-20b:free" },
  { provider: "openrouter", model: "inclusionai/ling-3.0-flash:free" },
  { provider: "openrouter", model: "nvidia/nemotron-3-nano-30b-a3b:free" },
  { provider: "openrouter", model: "openrouter/free" },
];

const ENDPOINTS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
} as const;

const KEYS = {
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

const CONTEXT = `[Джерело 1: POST /api/merchant/invoice/create]
# POST /api/merchant/invoice/create
Призначення: Створення рахунку для оплати
Тіло запиту (application/json):
  - amount (number) [обовʼязкове] — сума у мінімальних одиницях (копійках)
  - ccy (number) — код валюти ISO 4217, за замовчуванням 980
  - redirectUrl (string) — адреса повернення після оплати
  - webHookUrl (string) — адреса для сповіщень про зміну статусу
Відповіді:
  200 — успіх
    - invoiceId (string)
    - pageUrl (string)`;

interface Result {
  candidate: Candidate;
  jsonOk: boolean;
  groundedOk: boolean;
  groundedNote: string;
  ms: number;
  error?: string;
}

async function call(
  candidate: Candidate,
  system: string,
  user: string,
  maxTokens: number,
  json = false,
): Promise<string> {
  const apiKey = process.env[KEYS[candidate.provider]];
  if (!apiKey) throw new Error(`нема ${KEYS[candidate.provider]}`);

  // Безкоштовні пули регулярно віддають 429 — одна помилка не означає,
  // що модель непридатна, тож даємо їй другий шанс із паузою.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(ENDPOINTS[candidate.provider], {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: candidate.model,
        temperature: 0.1,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // Структурований вивід там, де він потрібен: без нього навіть сильні
        // моделі обгортають JSON у пояснення й ламають маршрутизацію.
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (response.status === 429 && attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 120)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }
}

function parsesAsJson(raw: string): boolean {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return false;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return typeof parsed?.needsLiveData === "boolean";
  } catch {
    return false;
  }
}

async function evaluate(candidate: Candidate): Promise<Result> {
  const started = Date.now();

  try {
    const jsonRaw = await call(
      candidate,
      'Ти класифікатор. Відповідай ЛИШЕ JSON виду {"needsLiveData": true|false}. ' +
        "true — питання про поточний курс валют; false — питання про будову API.",
      "як створити рахунок на оплату?",
      60,
      true,
    );

    const groundedRaw = await call(
      candidate,
      "Відповідай виключно за наданим контекстом, українською, стисло. " +
        "Не вигадуй полів, яких нема в контексті.",
      `${CONTEXT}\n\nПитання: які поля потрібні, щоб створити рахунок, і що повертається у відповіді?`,
      400,
    );

    const lower = groundedRaw.toLowerCase();
    // Мінімальна перевірка на предметність: назвав обовʼязкове поле і те,
    // що повертається. І не вигадав поля, якого в контексті нема.
    const mentionsAmount = lower.includes("amount");
    const mentionsInvoiceId = lower.includes("invoiceid");
    const hallucinated = lower.includes("merchantpayminfo") || lower.includes("basketorder");
    const cyrillic = /[а-яіїєґ]/i.test(groundedRaw);

    const groundedOk = mentionsAmount && mentionsInvoiceId && !hallucinated && cyrillic;

    return {
      candidate,
      jsonOk: parsesAsJson(jsonRaw),
      groundedOk,
      groundedNote: [
        mentionsAmount ? "amount✓" : "amount✗",
        mentionsInvoiceId ? "invoiceId✓" : "invoiceId✗",
        hallucinated ? "ВИГАДАВ" : "",
        cyrillic ? "" : "не українською",
      ]
        .filter(Boolean)
        .join(" "),
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      candidate,
      jsonOk: false,
      groundedOk: false,
      groundedNote: "",
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  await loadDotEnv();

  console.log(`Перевіряю ${CANDIDATES.length} моделей…\n`);
  const results: Result[] = [];

  for (const candidate of CANDIDATES) {
    process.stdout.write(`  ${candidate.provider}/${candidate.model} … `);
    const result = await evaluate(candidate);
    results.push(result);

    if (result.error) console.log(`✗ ${result.error.slice(0, 90)}`);
    else
      console.log(
        `${result.jsonOk ? "JSON✓" : "JSON✗"} ${result.groundedOk ? "grounded✓" : "grounded✗"} ` +
          `${result.ms} мс  ${result.groundedNote}`,
      );
  }

  const usable = results
    .filter((r) => !r.error && r.jsonOk && r.groundedOk)
    .sort((a, b) => a.ms - b.ms);

  console.log(`\n── придатні (обидва тести пройдені), за швидкістю:`);
  for (const result of usable) {
    console.log(`  ${result.ms.toString().padStart(6)} мс  ${result.candidate.provider}/${result.candidate.model}`);
  }

  if (usable.length === 0) console.log("  (жодної — перевір ключі)");
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});

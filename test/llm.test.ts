import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  AllModelsFailedError,
  LlmClient,
  classifyStatus,
  extractJson,
  type LlmDeps,
} from "../src/llm.ts";
import { metrics } from "../src/metrics.ts";
import { JSON_CHAIN, PROSE_CHAIN, REASONING_TOKEN_FLOOR } from "../src/providers.ts";

// ── допоміжна оснастка ──────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  model: string;
  maxTokens: number;
  hasJsonMode: boolean;
  authorization: string;
}

/** Відповідь, яку віддав би справжній провайдер. */
function ok(content: string, finishReason = "stop", tokens = { prompt: 10, completion: 5 }) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: tokens.prompt, completion_tokens: tokens.completion },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function httpError(status: number, body = "{}", headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

interface Harness {
  client: LlmClient;
  requests: RecordedRequest[];
  sleeps: number[];
  setResponder: (fn: (req: RecordedRequest, callIndex: number) => Response | Promise<Response>) => void;
  advance: (ms: number) => void;
}

function makeHarness(
  env: Record<string, string> = {
    GROQ_API_KEY: "groq-key",
    OPENROUTER_API_KEY: "or-key",
  },
  config = {},
): Harness {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  let responder: (req: RecordedRequest, i: number) => Response | Promise<Response> = () => ok("{}");

  const deps: LlmDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const request: RecordedRequest = {
        url: String(url),
        model: body.model,
        maxTokens: body.max_tokens,
        hasJsonMode: Boolean(body.response_format),
        authorization: headers.authorization ?? "",
      };
      requests.push(request);
      return responder(request, requests.length - 1);
    }) as unknown as typeof fetch,
    now: () => clock,
    // Пауза не спить по-справжньому, лише рухає годинник — тести мають
    // перевіряти політику відкату, а не чекати на неї.
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    env: env as NodeJS.ProcessEnv,
    random: () => 0,
  };

  return {
    client: new LlmClient(deps, config),
    requests,
    sleeps,
    setResponder: (fn) => {
      responder = fn;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

const PROMPT = { system: "s", user: "u" };

beforeEach(() => metrics.reset());

// ── тести ───────────────────────────────────────────────────────────────────

describe("classifyStatus", () => {
  it("розрізняє класи помилок", () => {
    assert.equal(classifyStatus(401), "auth");
    assert.equal(classifyStatus(403), "auth");
    assert.equal(classifyStatus(404), "model_missing");
    assert.equal(classifyStatus(429), "rate_limit");
    assert.equal(classifyStatus(500), "server");
    assert.equal(classifyStatus(503), "server");
    assert.equal(classifyStatus(400), "bad_request");
    assert.equal(classifyStatus(422), "bad_request");
  });
});

describe("extractJson", () => {
  it("читає чистий JSON", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  it("читає JSON у markdown-огорожі", () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  it("читає JSON серед пояснень", () => {
    assert.deepEqual(extractJson('Ось відповідь: {"a":1} — готово'), { a: 1 });
  });

  it("бере зовнішній об'єкт при вкладеності", () => {
    assert.deepEqual(extractJson('{"a":{"b":2}}'), { a: { b: 2 } });
  });

  it("повертає undefined на битому JSON", () => {
    assert.equal(extractJson('{"a":'), undefined);
  });

  it("повертає undefined, коли дужок немає", () => {
    assert.equal(extractJson("просто текст"), undefined);
  });

  it("повертає undefined на порожньому рядку", () => {
    assert.equal(extractJson(""), undefined);
  });
});

describe("успішний виклик", () => {
  it("бере першу модель ланцюжка й повертає текст", async () => {
    const h = makeHarness();
    h.setResponder(() => ok("привіт"));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "привіт");
    assert.equal(result.spec, PROSE_CHAIN[0]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]?.authorization, "Bearer groq-key");
  });

  it("для json:true бере JSON-ланцюжок і вмикає response_format", async () => {
    const h = makeHarness();
    h.setResponder(() => ok('{"ok":true}'));

    const result = await h.client.chat({ ...PROMPT, json: true });

    assert.equal(result.spec, JSON_CHAIN[0]);
    assert.equal(h.requests[0]?.hasJsonMode, true);
  });

  it("записує токени в метрики", async () => {
    const h = makeHarness();
    h.setResponder(() => ok("текст", "stop", { prompt: 100, completion: 20 }));

    await h.client.chat(PROMPT);

    assert.equal(metrics.totalTokens, 120);
    assert.equal(metrics.callCount, 1);
  });
});

describe("401 — недійсний ключ", () => {
  it("вимикає провайдера цілком і переходить до наступного", async () => {
    const h = makeHarness();
    h.setResponder((req) => (req.url.includes("groq") ? httpError(401) : ok("з openrouter")));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "з openrouter");
    assert.equal(result.spec.provider, "openrouter");
    // Обидві groq-моделі мали бути пропущені після першої ж 401,
    // а не пробуватись по два рази кожна.
    const groqCalls = h.requests.filter((r) => r.url.includes("groq"));
    assert.equal(groqCalls.length, 1);
  });

  it("після 401 groq зникає зі списку доступних", async () => {
    const h = makeHarness();
    h.setResponder((req) => (req.url.includes("groq") ? httpError(401) : ok("ok")));

    await h.client.chat(PROMPT);

    assert.ok(h.client.availableModels(PROSE_CHAIN).every((s) => s.provider !== "groq"));
  });

  it("не робить жодного запиту, якщо ключів немає", async () => {
    const h = makeHarness({});
    await assert.rejects(() => h.client.chat(PROMPT), AllModelsFailedError);
    assert.equal(h.requests.length, 0);
    assert.equal(h.client.hasAnyKey(), false);
  });
});

describe("404 — моделі не існує", () => {
  it("вимикає лише цю модель, провайдер лишається живим", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => (i === 0 ? httpError(404) : ok("друга модель")));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "друга модель");
    assert.equal(result.spec, PROSE_CHAIN[1]);
    assert.equal(h.requests.length, 2);
  });
});

describe("400 — запит не прийнято", () => {
  it("знімає json-режим і повторює ту саму модель", async () => {
    const h = makeHarness();
    h.setResponder((req) => (req.hasJsonMode ? httpError(400) : ok('{"ok":1}')));

    const result = await h.client.chat({ ...PROMPT, json: true });

    assert.equal(result.text, '{"ok":1}');
    assert.equal(result.spec, JSON_CHAIN[0]);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0]?.hasJsonMode, true);
    assert.equal(h.requests[1]?.hasJsonMode, false);
  });

  it("400 без json-режиму вимикає модель і йде далі", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => (i === 0 ? httpError(400) : ok("наступна")));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "наступна");
    assert.equal(h.requests.length, 2);
  });

  it("усі моделі JSON-ланцюжка вміють json-режим", () => {
    // Інваріант реєстру: модель, що падає з 400 на response_format, не має
    // права стояти в ланцюжку, де json-режим потрібен за визначенням.
    for (const spec of JSON_CHAIN) {
      assert.equal(spec.supportsJsonMode, true, `${spec.model} не вміє json-режим`);
    }
  });

  it("модель без json-режиму живе лише в прозовому ланцюжку", () => {
    const noJson = PROSE_CHAIN.filter((s) => !s.supportsJsonMode);
    assert.ok(noJson.length > 0, "такий випадок має бути покритий реєстром");
    for (const spec of noJson) {
      assert.ok(!JSON_CHAIN.some((j) => j.model === spec.model));
    }
  });
});

describe("429 — ліміт", () => {
  it("повторює модель із паузою, потім переходить далі", async () => {
    const h = makeHarness();
    h.setResponder((req) => (req.model === PROSE_CHAIN[0]?.model ? httpError(429) : ok("далі")));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "далі");
    const first = h.requests.filter((r) => r.model === PROSE_CHAIN[0]?.model);
    assert.equal(first.length, 2, "модель має отримати дві спроби");
    assert.equal(h.sleeps.length, 1, "між спробами має бути одна пауза");
  });

  it("поважає заголовок Retry-After", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) =>
      i === 0 ? httpError(429, "{}", { "retry-after": "2" }) : ok("ок"),
    );

    await h.client.chat(PROMPT);

    assert.equal(h.sleeps[0], 2000);
  });

  it("не перевищує стелю паузи навіть на величезному Retry-After", async () => {
    const h = makeHarness(undefined, { backoffMaxMs: 4000 });
    h.setResponder((_req, i) =>
      i === 0 ? httpError(429, "{}", { "retry-after": "3600" }) : ok("ок"),
    );

    await h.client.chat(PROMPT);

    assert.ok((h.sleeps[0] ?? 0) <= 4000);
  });
});

describe("5xx, мережа й порожні відповіді", () => {
  it("повторює на 500 і йде до наступної моделі", async () => {
    const h = makeHarness();
    h.setResponder((req) => (req.model === PROSE_CHAIN[0]?.model ? httpError(503) : ok("ок")));

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "ок");
  });

  it("мережевий збій не валить ланцюжок", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => {
      if (i < 2) throw new Error("ECONNRESET");
      return ok("вижили");
    });

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "вижили");
  });

  it("порожня відповідь вважається збоєм", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => (i === 0 ? ok("   ") : ok("нормальна")));

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "нормальна");
  });

  it("відповідь без choices вважається збоєм", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) =>
      i === 0
        ? new Response(JSON.stringify({}), { status: 200 })
        : ok("нормальна"),
    );

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "нормальна");
  });
});

describe("обрив по ліміту токенів", () => {
  it("finish_reason=length не приймається як відповідь", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => (i === 0 ? ok('{"ne', "length") : ok('{"ok":1}')));

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, '{"ok":1}');
  });

  it("для JSON обрив приймається, якщо відповідь усе одно розбирається", async () => {
    // llama-3.1-8b-instant віддає валідний JSON із переносами й впирається
    // в стелю рівно на закривальній дужці. Викидати такий результат означало
    // б втратити найшвидшу модель ланцюжка на порожньому місці.
    const h = makeHarness();
    h.setResponder(() => ok('{\n  "needsLiveData": false\n}', "length"));

    const result = await h.client.chat({ ...PROMPT, json: true });

    assert.equal(result.spec, JSON_CHAIN[0]);
    assert.equal(h.requests.length, 1, "другої спроби бути не мало");
  });

  it("для JSON обрив НЕ приймається, якщо відповідь розсипалась", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => (i === 0 ? ok('{"ne', "length") : ok('{"ok":1}')));

    const result = await h.client.chat({ ...PROMPT, json: true });

    assert.equal(result.text, '{"ok":1}');
    assert.ok(h.requests.length > 1);
  });

  it("для прози обрив завжди вважається збоєм", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => (i === 0 ? ok("речення обірване на пів", "length") : ok("ціле")));

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "ціле");
  });

  it("повтор після обриву йде з більшим бюджетом токенів", async () => {
    const h = makeHarness();
    h.setResponder((_req, i) => (i === 0 ? ok("обрізок", "length") : ok("повний")));

    await h.client.chat({ ...PROMPT, maxTokens: 100 });

    assert.equal(h.requests[0]?.maxTokens, 100);
    assert.ok(
      (h.requests[1]?.maxTokens ?? 0) > 100,
      `другий бюджет мав вирости, а він ${h.requests[1]?.maxTokens}`,
    );
  });

  it("reasoning-моделі одразу дають розширений бюджет", async () => {
    const h = makeHarness({ OPENROUTER_API_KEY: "or-key" });
    const reasoningSpec = PROSE_CHAIN.find((s) => s.reasoning);
    assert.ok(reasoningSpec, "у ланцюжку має бути reasoning-модель");

    h.setResponder((req) => (req.model === reasoningSpec.model ? ok("ок") : httpError(500)));

    await h.client.chat({ ...PROMPT, maxTokens: 60 });

    const request = h.requests.find((r) => r.model === reasoningSpec.model);
    assert.equal(request?.maxTokens, REASONING_TOKEN_FLOOR);
  });

  it("звичайна модель отримує рівно запитаний бюджет", async () => {
    const h = makeHarness();
    h.setResponder(() => ok("ок"));

    await h.client.chat({ ...PROMPT, maxTokens: 60 });

    assert.equal(h.requests[0]?.maxTokens, 60);
  });
});

describe("запобіжник", () => {
  it("розмикається після порога і виводить модель зі списку", async () => {
    const h = makeHarness(undefined, { breakerThreshold: 2, attemptsPerModel: 2 });
    h.setResponder((req) => (req.model === PROSE_CHAIN[0]?.model ? httpError(500) : ok("ок")));

    await h.client.chat(PROMPT);

    const available = h.client.availableModels(PROSE_CHAIN);
    assert.ok(!available.some((s) => s.model === PROSE_CHAIN[0]?.model));
  });

  it("після вистигання модель повертається в обіг", async () => {
    const h = makeHarness(undefined, {
      breakerThreshold: 2,
      attemptsPerModel: 2,
      breakerCooldownMs: 60_000,
    });
    h.setResponder((req) => (req.model === PROSE_CHAIN[0]?.model ? httpError(500) : ok("ок")));

    await h.client.chat(PROMPT);
    assert.ok(!h.client.availableModels(PROSE_CHAIN).some((s) => s.model === PROSE_CHAIN[0]?.model));

    h.advance(61_000);
    assert.ok(h.client.availableModels(PROSE_CHAIN).some((s) => s.model === PROSE_CHAIN[0]?.model));
  });

  it("успіх обнуляє лічильник невдач", async () => {
    const h = makeHarness(undefined, { breakerThreshold: 2, attemptsPerModel: 2 });
    h.setResponder((_req, i) => (i === 0 ? httpError(500) : ok("ок")));

    await h.client.chat(PROMPT);
    await h.client.chat(PROMPT);

    assert.ok(h.client.availableModels(PROSE_CHAIN).some((s) => s.model === PROSE_CHAIN[0]?.model));
  });

  it("reset повертає клієнта у вихідний стан", async () => {
    const h = makeHarness();
    h.setResponder(() => httpError(401));

    await assert.rejects(() => h.client.chat(PROMPT));
    assert.equal(h.client.availableModels(PROSE_CHAIN).length, 0);

    h.client.reset();
    assert.equal(h.client.availableModels(PROSE_CHAIN).length, PROSE_CHAIN.length);
  });
});

describe("повний провал", () => {
  it("кидає AllModelsFailedError із журналом спроб", async () => {
    const h = makeHarness();
    h.setResponder(() => httpError(500));

    await assert.rejects(
      () => h.client.chat(PROMPT),
      (error: unknown) => {
        assert.ok(error instanceof AllModelsFailedError);
        assert.ok(error.attempts.length > 0);
        assert.ok(error.attempts.every((a) => a.kind === "server"));
        assert.match(error.message, /жодна модель не відповіла/);
        return true;
      },
    );
  });

  it("проходить усі моделі ланцюжка, перш ніж здатися", async () => {
    const h = makeHarness();
    h.setResponder(() => httpError(500));

    await assert.rejects(() => h.client.chat(PROMPT));

    const tried = new Set(h.requests.map((r) => r.model));
    assert.equal(tried.size, PROSE_CHAIN.length);
  });

  it("зупиняється по вичерпанню загального бюджету часу", async () => {
    const h = makeHarness(undefined, { totalDeadlineMs: 1000, backoffBaseMs: 900 });
    h.setResponder(() => httpError(429));

    await assert.rejects(
      () => h.client.chat(PROMPT),
      (error: unknown) => {
        assert.ok(error instanceof AllModelsFailedError);
        assert.ok(error.attempts.some((a) => a.detail.includes("бюджет")));
        return true;
      },
    );

    assert.ok(h.requests.length < PROSE_CHAIN.length * 2, "мав зупинитись достроково");
  });
});

describe("вибір доступних моделей", () => {
  it("відсіює провайдера без ключа", () => {
    const h = makeHarness({ OPENROUTER_API_KEY: "or-key" });
    assert.ok(h.client.availableModels(PROSE_CHAIN).every((s) => s.provider === "openrouter"));
  });

  it("без жодного ключа список порожній", () => {
    const h = makeHarness({});
    assert.equal(h.client.availableModels(PROSE_CHAIN).length, 0);
  });

  it("hasAnyKey бачить будь-який один ключ", () => {
    assert.equal(makeHarness({ GROQ_API_KEY: "x" }).client.hasAnyKey(), true);
    assert.equal(makeHarness({ OPENROUTER_API_KEY: "x" }).client.hasAnyKey(), true);
    assert.equal(makeHarness({}).client.hasAnyKey(), false);
  });
});

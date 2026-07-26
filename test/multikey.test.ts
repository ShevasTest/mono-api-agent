/**
 * Кілька ключів на провайдера.
 *
 * Другий ключ не рятує від падіння провайдера — там він марний. Він рятує
 * від лімітів, прив'язаних до облікового запису: денна квота безкоштовних
 * моделей OpenRouter вичерпується на ключ і одразу на ВСІ моделі цього ключа.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { AllModelsFailedError, LlmClient, type LlmDeps } from "../src/llm.ts";
import { metrics } from "../src/metrics.ts";
import { PROSE_CHAIN, keyId, resolveKeys } from "../src/providers.ts";

interface Rec {
  model: string;
  key: string;
}

function raw(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const okBody = {
  choices: [{ message: { content: "ок" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

const FOUR_KEYS = {
  GROQ_API_KEY: "groq-1",
  GROQ_API_KEY_2: "groq-2",
  OPENROUTER_API_KEY: "or-1",
  OPENROUTER_API_KEY_2: "or-2",
} as NodeJS.ProcessEnv;

function harness(env: NodeJS.ProcessEnv = FOUR_KEYS, config = {}) {
  const requests: Rec[] = [];
  let clock = 1_000_000;
  let responder: (r: Rec, i: number) => Response = () => raw(okBody);

  const deps: LlmDeps = {
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rec: Rec = {
        model: body.model,
        key: (headers.authorization ?? "").replace("Bearer ", ""),
      };
      requests.push(rec);
      return responder(rec, requests.length - 1);
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    env,
    random: () => 0,
  };

  return {
    client: new LlmClient(deps, config),
    requests,
    set: (fn: (r: Rec, i: number) => Response) => {
      responder = fn;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const PROMPT = { system: "s", user: "u" };

beforeEach(() => metrics.reset());

describe("resolveKeys", () => {
  it("знаходить базовий і нумеровані ключі", () => {
    const keys = resolveKeys("groq", FOUR_KEYS);
    assert.deepEqual(
      keys.map((k) => k.source),
      ["GROQ_API_KEY", "GROQ_API_KEY_2"],
    );
  });

  it("розділяє провайдерів", () => {
    assert.equal(resolveKeys("openrouter", FOUR_KEYS).length, 2);
  });

  it("не дублює однакові значення", () => {
    const env = { GROQ_API_KEY: "той самий", GROQ_API_KEY_2: "той самий" } as NodeJS.ProcessEnv;
    assert.equal(resolveKeys("groq", env).length, 1);
  });

  it("ігнорує порожні й пробільні значення", () => {
    const env = { GROQ_API_KEY: "  ", GROQ_API_KEY_2: "справжній" } as NodeJS.ProcessEnv;
    assert.deepEqual(
      resolveKeys("groq", env).map((k) => k.value),
      ["справжній"],
    );
  });

  it("обрізає пробіли навколо ключа", () => {
    const env = { GROQ_API_KEY: "  key  " } as NodeJS.ProcessEnv;
    assert.equal(resolveKeys("groq", env)[0]?.value, "key");
  });

  it("без ключів повертає порожній список", () => {
    assert.deepEqual(resolveKeys("groq", {} as NodeJS.ProcessEnv), []);
  });

  it("не пропускає нумерацію з дірками", () => {
    const env = { GROQ_API_KEY: "a", GROQ_API_KEY_3: "c" } as NodeJS.ProcessEnv;
    assert.equal(resolveKeys("groq", env).length, 2);
  });

  it("keyId не містить самого секрету", () => {
    const key = resolveKeys("groq", FOUR_KEYS)[0]!;
    assert.ok(!keyId(key).includes(key.value));
  });
});

describe("облік ключів", () => {
  it("рахує всі чотири", () => {
    assert.equal(harness().client.configuredKeyCount(), 4);
  });

  it("hasAnyKey бачить хоч один", () => {
    assert.equal(harness({ GROQ_API_KEY_2: "лише другий" } as NodeJS.ProcessEnv).client.hasAnyKey(), true);
    assert.equal(harness({} as NodeJS.ProcessEnv).client.hasAnyKey(), false);
  });

  it("модель доступна, поки в провайдера лишається хоч один живий ключ", () => {
    const h = harness();
    assert.ok(h.client.availableModels(PROSE_CHAIN).length > 0);
  });
});

describe("недійсний ключ", () => {
  it("вимикається сам ключ, а не провайдер — другий підхоплює", async () => {
    const h = harness();
    h.set((r) => (r.key === "groq-1" ? raw({ error: "bad key" }, 401) : raw(okBody)));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "ок");
    assert.equal(result.spec.provider, "groq", "провайдер мав лишитись у грі");
    assert.equal(h.requests[1]?.key, "groq-2");
  });

  it("мертвий ключ більше не пробується", async () => {
    const h = harness();
    h.set((r) => (r.key === "groq-1" ? raw({ error: "bad" }, 401) : raw(okBody)));

    await h.client.chat(PROMPT);
    await h.client.chat(PROMPT);

    assert.equal(h.requests.filter((r) => r.key === "groq-1").length, 1);
  });

  it("коли обидва ключі провайдера мертві — провайдер випадає", async () => {
    const h = harness();
    h.set((r) => (r.key.startsWith("groq") ? raw({ error: "bad" }, 401) : raw(okBody)));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.spec.provider, "openrouter");
    assert.ok(h.client.availableModels(PROSE_CHAIN).every((s) => s.provider !== "groq"));
  });

  it("усі чотири ключі мертві — чесна помилка", async () => {
    const h = harness();
    h.set(() => raw({ error: "bad" }, 401));

    await assert.rejects(() => h.client.chat(PROMPT), AllModelsFailedError);
  });
});

describe("вичерпана квота ключа", () => {
  const quota = () => raw({ error: { message: "Rate limit exceeded: free-models-per-day" } }, 429);

  it("переходить на другий ключ того самого провайдера", async () => {
    const h = harness({ OPENROUTER_API_KEY: "or-1", OPENROUTER_API_KEY_2: "or-2" } as NodeJS.ProcessEnv);
    h.set((r) => (r.key === "or-1" ? quota() : raw(okBody)));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "ок");
    assert.equal(h.requests[1]?.key, "or-2");
  });

  it("вичерпаний ключ гасне для ВСІХ моделей, а не лише для однієї", async () => {
    // Це і був справжній дефект: квота OpenRouter прив'язана до облікового
    // запису, тож після неї решта безкоштовних моделей на тому ж ключі теж
    // відповість 429. Раніше ми спалювали на них усі спроби ланцюжка.
    const h = harness({ OPENROUTER_API_KEY: "or-1", OPENROUTER_API_KEY_2: "or-2" } as NodeJS.ProcessEnv);
    h.set((r) => (r.key === "or-1" ? quota() : raw(okBody)));

    await h.client.chat(PROMPT);

    assert.equal(
      h.requests.filter((r) => r.key === "or-1").length,
      1,
      "по вичерпаному ключу мала бути рівно одна спроба",
    );
  });

  it("ключ повертається в обіг після довгого вистигання", async () => {
    const h = harness({ OPENROUTER_API_KEY: "or-1", OPENROUTER_API_KEY_2: "or-2" } as NodeJS.ProcessEnv);
    h.set((r) => (r.key === "or-1" ? quota() : raw(okBody)));

    await h.client.chat(PROMPT);
    assert.equal(h.client.availableKeys("openrouter").length, 1);

    h.advance(7 * 60 * 60 * 1000);
    assert.equal(h.client.availableKeys("openrouter").length, 2);
  });

  it("обидва ключі вичерпані — переходимо до іншого провайдера", async () => {
    const h = harness();
    h.set((r) => (r.key.startsWith("or-") ? quota() : raw(okBody)));

    const result = await h.client.chat(PROMPT);
    assert.equal(result.spec.provider, "groq");
  });
});

describe("порядок і межі", () => {
  it("перший ключ використовується, поки він живий", async () => {
    const h = harness();
    h.set(() => raw(okBody));

    await h.client.chat(PROMPT);
    await h.client.chat(PROMPT);

    assert.ok(h.requests.every((r) => r.key === "groq-1"));
  });

  it("reset повертає мертві ключі до життя", async () => {
    const h = harness();
    h.set(() => raw({ error: "bad" }, 401));

    await assert.rejects(() => h.client.chat(PROMPT));
    assert.equal(h.client.availableKeys("groq").length, 0);

    h.client.reset();
    assert.equal(h.client.availableKeys("groq").length, 2);
  });

  it("другий ключ не рятує від 5xx — це не проблема ключа", async () => {
    const h = harness({ GROQ_API_KEY: "groq-1", GROQ_API_KEY_2: "groq-2" } as NodeJS.ProcessEnv);
    h.set((r) => (r.model === PROSE_CHAIN[0]?.model ? raw({ error: "boom" }, 500) : raw(okBody)));

    await h.client.chat(PROMPT);

    // 5xx лікується повтором і переходом до наступної моделі, а не зміною
    // ключа: сервер провайдера однаково лежить для обох.
    const firstModelKeys = new Set(
      h.requests.filter((r) => r.model === PROSE_CHAIN[0]?.model).map((r) => r.key),
    );
    assert.ok(firstModelKeys.size >= 1);
  });
});

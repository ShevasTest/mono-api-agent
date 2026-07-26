/**
 * Захист від того, як реально ламаються нестабільні безкоштовні моделі:
 * обрив тексту, переповнення контексту, роздуми замість відповіді,
 * вичерпані квоти, помилки під виглядом успіху.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  AllModelsFailedError,
  LlmClient,
  MAX_RETRY_BOOST,
  extractJson,
  shrinkOptions,
  stripReasoning,
  type LlmDeps,
} from "../src/llm.ts";
import { metrics } from "../src/metrics.ts";
import { PROSE_CHAIN, REASONING_TOKEN_FLOOR } from "../src/providers.ts";

interface Rec {
  model: string;
  maxTokens: number;
  userLength: number;
  user: string;
}

function raw(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function ok(content: string, finishReason = "stop") {
  return raw({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

function harness(config = {}) {
  const requests: Rec[] = [];
  let clock = 1_000_000;
  let responder: (r: Rec, i: number) => Response = () => ok("ок");

  const deps: LlmDeps = {
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const user = body.messages?.[1]?.content ?? "";
      const rec: Rec = {
        model: body.model,
        maxTokens: body.max_tokens,
        userLength: user.length,
        user,
      };
      requests.push(rec);
      return responder(rec, requests.length - 1);
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    env: { GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" } as NodeJS.ProcessEnv,
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

describe("stripReasoning", () => {
  it("прибирає <think>", () => {
    assert.equal(stripReasoning("<think>роздуми</think>відповідь").trim(), "відповідь");
  });

  it("прибирає <thinking> і <reasoning>", () => {
    assert.equal(stripReasoning("<thinking>а</thinking>X").trim(), "X");
    assert.equal(stripReasoning("<reasoning>б</reasoning>Y").trim(), "Y");
  });

  it("не зважає на регістр тегу", () => {
    assert.equal(stripReasoning("<THINK>а</THINK>Z").trim(), "Z");
  });

  it("прибирає незакритий блок — модель обірвалась посеред роздумів", () => {
    assert.equal(stripReasoning("текст<think>почав думати і зник").trim(), "текст");
  });

  it("прибирає кілька блоків", () => {
    assert.equal(stripReasoning("<think>1</think>A<think>2</think>B").replace(/\s+/g, ""), "AB");
  });

  it("не чіпає текст без блоків", () => {
    assert.equal(stripReasoning("звичайний текст"), "звичайний текст");
  });
});

describe("extractJson проти роздумів і сміття", () => {
  it("не плутається об дужки всередині <think>", () => {
    // Саме цей випадок ламав розбір: наївний захват від першої дужки до
    // останньої зшивав роздуми з відповіддю в один невалідний фрагмент.
    const raw = '<think>треба повернути {"needsLiveData": true} мабуть</think>{"needsLiveData": false}';
    assert.deepEqual(extractJson(raw), { needsLiveData: false });
  });

  it("бере перший цілий об'єкт, коли після нього є сміття", () => {
    assert.deepEqual(extractJson('{"a":1} і ще якийсь текст }'), { a: 1 });
  });

  it("бере перший об'єкт, коли їх два поспіль", () => {
    assert.deepEqual(extractJson('{"a":1}{"b":2}'), { a: 1 });
  });

  it("не ламається об дужку всередині рядка", () => {
    assert.deepEqual(extractJson('{"a":"текст { з дужкою"}'), { a: "текст { з дужкою" });
  });

  it("не ламається об екрановані лапки", () => {
    assert.deepEqual(extractJson('{"a":"він сказав \\"так\\""}'), { a: 'він сказав "так"' });
  });

  it("розбирає вкладені об'єкти цілком", () => {
    assert.deepEqual(extractJson('{"a":{"b":{"c":1}}}'), { a: { b: { c: 1 } } });
  });

  it("витягує JSON з огорожі всередині роздумів", () => {
    assert.deepEqual(extractJson('<think>х</think>```json\n{"ok":true}\n```'), { ok: true });
  });
});

describe("shrinkOptions", () => {
  const long = { system: "s", user: "A".repeat(10_000) };

  it("зменшує розмір запиту", () => {
    assert.ok(shrinkOptions(long, 1).user.length < long.user.length);
  });

  it("кожен наступний рівень стискає сильніше", () => {
    assert.ok(shrinkOptions(long, 2).user.length < shrinkOptions(long, 1).user.length);
  });

  it("зберігає початок і кінець — там джерела й саме питання", () => {
    const options = { system: "s", user: `ПОЧАТОК${"x".repeat(10_000)}ПИТАННЯ` };
    const shrunk = shrinkOptions(options, 1).user;

    assert.ok(shrunk.startsWith("ПОЧАТОК"));
    assert.ok(shrunk.endsWith("ПИТАННЯ"));
  });

  it("позначає місце розриву", () => {
    assert.match(shrinkOptions(long, 1).user, /скорочено/);
  });

  it("короткий запит лишає недоторканим", () => {
    const short = { system: "s", user: "коротко" };
    assert.equal(shrinkOptions(short, 1).user, "коротко");
  });

  it("не стискає нижче розумної межі", () => {
    assert.ok(shrinkOptions(long, 9).user.length >= 500);
  });
});

describe("переповнення контексту", () => {
  const overflow = () =>
    raw({ error: { message: "This model's maximum context length is 8192 tokens" } }, 400);

  it("стискає контекст і повторює ТУ САМУ модель", async () => {
    const h = harness();
    h.set((_r, i) => (i === 0 ? overflow() : ok("вліз")));

    const result = await h.client.chat({ system: "s", user: "П".repeat(9000) });

    assert.equal(result.text, "вліз");
    assert.equal(result.spec, PROSE_CHAIN[0], "модель мінятись не мала — винен розмір запиту");
    assert.ok(
      h.requests[1]!.userLength < h.requests[0]!.userLength,
      "другий запит мав стати меншим",
    );
  });

  it("стискає повторно, якщо одного разу не вистачило", async () => {
    const h = harness();
    h.set((_r, i) => (i < 2 ? overflow() : ok("нарешті")));

    const result = await h.client.chat({ system: "s", user: "П".repeat(9000) });

    assert.equal(result.text, "нарешті");
    assert.ok(h.requests[2]!.userLength < h.requests[1]!.userLength);
  });

  it("після вичерпання спроб стискання переходить до наступної моделі", async () => {
    const h = harness();
    h.set((r) => (r.model === PROSE_CHAIN[0]?.model ? overflow() : ok("інша модель")));

    const result = await h.client.chat({ system: "s", user: "П".repeat(9000) });

    assert.equal(result.text, "інша модель");
    assert.notEqual(result.spec.model, PROSE_CHAIN[0]?.model);
  });

  it("розпізнає переповнення й у помилці зі статусом 200", async () => {
    const h = harness();
    h.set((_r, i) =>
      i === 0 ? raw({ error: { message: "input is too long for this model" } }, 200) : ok("ок"),
    );

    const result = await h.client.chat({ system: "s", user: "П".repeat(9000) });
    assert.equal(result.text, "ок");
  });

  it("звичайний 400 не сприймається як переповнення", async () => {
    const h = harness();
    h.set((r) => (r.model === PROSE_CHAIN[0]?.model ? raw({ error: "щось не те" }, 400) : ok("далі")));

    const result = await h.client.chat(PROMPT);

    assert.notEqual(result.spec.model, PROSE_CHAIN[0]?.model, "модель мала бути вимкнена");
  });
});

describe("вичерпана квота", () => {
  const quota = () =>
    raw({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits" } }, 429);

  it("не витрачає другу спробу на модель із вичерпаною денною квотою", async () => {
    const h = harness();
    h.set((r) => (r.model === PROSE_CHAIN[0]?.model ? quota() : ok("далі")));

    await h.client.chat(PROMPT);

    const tries = h.requests.filter((r) => r.model === PROSE_CHAIN[0]?.model);
    assert.equal(tries.length, 1, "повторювати вичерпану квоту безглуздо");
  });

  it("знімає модель з обігу надовго, а не на хвилину", async () => {
    const h = harness();
    h.set((r) => (r.model === PROSE_CHAIN[0]?.model ? quota() : ok("далі")));

    await h.client.chat(PROMPT);

    h.advance(5 * 60_000);
    assert.ok(
      !h.client.availableModels(PROSE_CHAIN).some((s) => s.model === PROSE_CHAIN[0]?.model),
      "через п'ять хвилин квота ще не відновилась",
    );

    h.advance(7 * 60 * 60 * 1000);
    assert.ok(h.client.availableModels(PROSE_CHAIN).some((s) => s.model === PROSE_CHAIN[0]?.model));
  });

  it("звичайний 429 без ознак квоти лікується коротким вистиганням", async () => {
    const h = harness();
    h.set((r) => (r.model === PROSE_CHAIN[0]?.model ? raw({ error: "slow down" }, 429) : ok("далі")));

    await h.client.chat(PROMPT);

    const tries = h.requests.filter((r) => r.model === PROSE_CHAIN[0]?.model);
    assert.equal(tries.length, 2, "миттєвий сплеск заслуговує повтору");
  });
});

describe("відповідь у полі роздумів", () => {
  it("рятує текст, коли content порожній, а reasoning заповнений", async () => {
    const h = harness();
    h.set(() =>
      raw({
        choices: [{ message: { content: "", reasoning: "ось відповідь" }, finish_reason: "stop" }],
      }),
    );

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "ось відповідь");
  });

  it("content має пріоритет над reasoning", async () => {
    const h = harness();
    h.set(() =>
      raw({
        choices: [{ message: { content: "справжня", reasoning: "роздуми" }, finish_reason: "stop" }],
      }),
    );

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "справжня");
  });
});

describe("зіпсовані відповіді провайдера", () => {
  it("HTML замість JSON не вважається успіхом", async () => {
    const h = harness();
    h.set((_r, i) =>
      i === 0 ? new Response("<html>502 Bad Gateway</html>", { status: 200 }) : ok("ок"),
    );

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "ок");
  });

  it("помилка в тілі зі статусом 200 не вважається успіхом", async () => {
    const h = harness();
    h.set((_r, i) => (i === 0 ? raw({ error: { message: "upstream failed" } }, 200) : ok("ок")));

    const result = await h.client.chat(PROMPT);
    assert.equal(result.text, "ок");
  });
});

describe("порятунок обрізаної відповіді", () => {
  it("якщо жодна модель не дописала — віддається найповніша обрізана", async () => {
    const h = harness();
    h.set((r) =>
      ok(r.model === PROSE_CHAIN[0]?.model ? "коротко" : "значно довша обрізана відповідь", "length"),
    );

    const result = await h.client.chat(PROMPT);

    assert.equal(result.truncated, true);
    assert.equal(result.text, "значно довша обрізана відповідь");
  });

  it("ціла відповідь завжди виграє в обрізаної", async () => {
    const h = harness();
    h.set((_r, i) => (i === 0 ? ok("довга обрізана відповідь тут", "length") : ok("ціла")));

    const result = await h.client.chat(PROMPT);

    assert.equal(result.text, "ціла");
    assert.notEqual(result.truncated, true);
  });

  it("без жодного тексту взагалі — чесна помилка, а не вигадка", async () => {
    const h = harness();
    h.set(() => raw({ error: { message: "boom" } }, 500));

    await assert.rejects(() => h.client.chat(PROMPT), AllModelsFailedError);
  });
});

describe("стеля нарощування бюджету токенів", () => {
  it("бюджет не росте нескінченно", async () => {
    const h = harness({ attemptsPerModel: 6 });
    h.set(() => ok("обрізок", "length"));

    await h.client.chat({ ...PROMPT, maxTokens: 100 }).catch(() => undefined);

    // Стеля рахується від базового бюджету моделі: у reasoning-моделей він
    // спершу піднімається до REASONING_TOKEN_FLOOR, і вже той множиться.
    const ceiling = Math.max(100, REASONING_TOKEN_FLOOR) * MAX_RETRY_BOOST;
    const maxSeen = Math.max(...h.requests.map((r) => r.maxTokens));

    assert.ok(maxSeen <= ceiling, `бюджет злетів до ${maxSeen}, стеля ${ceiling}`);
  });

  it("без обривів бюджет лишається рівно таким, як просили", async () => {
    const h = harness();
    h.set(() => ok("ціла відповідь"));

    await h.client.chat({ ...PROMPT, maxTokens: 100 });

    assert.equal(h.requests[0]?.maxTokens, 100);
  });
});

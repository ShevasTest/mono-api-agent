import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEXICAL_WEIGHT,
  MAX_CHUNK_CHARS,
  MAX_TOTAL_CHARS,
  SCHEMA_PENALTY,
  cosineSimilarity,
  formatContext,
  lexicalScore,
  scoreChunk,
  tokenize,
  truncate,
} from "../src/scoring.ts";

describe("cosineSimilarity", () => {
  it("однакові одиничні вектори дають 1", () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  });

  it("ортогональні дають 0", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it("протилежні дають -1", () => {
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  });

  it("порожні вектори дають 0, а не NaN", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it("не падає на векторах різної довжини", () => {
    assert.equal(cosineSimilarity([1, 0, 5], [1, 0]), 1);
  });
});

describe("tokenize", () => {
  it("ріже по не-літерах і опускає регістр", () => {
    assert.deepEqual(tokenize("Invoice/Create?id=1"), ["invoice", "create"]);
  });

  it("відкидає токени коротші за 3 символи", () => {
    assert.deepEqual(tokenize("це API ok"), ["api"]);
  });

  it("зберігає кирилицю й відкидає короткий службовий 'як'", () => {
    assert.deepEqual(tokenize("як створити рахунок"), ["створити", "рахунок"]);
  });

  it("не ламається на українських літерах іїєґ", () => {
    assert.deepEqual(tokenize("їжак ґанок єдність"), ["їжак", "ґанок", "єдність"]);
  });

  it("порожній рядок дає порожній масив", () => {
    assert.deepEqual(tokenize(""), []);
  });

  it("рядок лише з розділових дає порожній масив", () => {
    assert.deepEqual(tokenize("--- /// ..."), []);
  });
});

describe("lexicalScore", () => {
  it("повний збіг дає 1", () => {
    assert.equal(lexicalScore(["invoice", "create"], "invoice create"), 1);
  });

  it("половина токенів дає 0.5", () => {
    assert.equal(lexicalScore(["invoice", "webhook"], "invoice status"), 0.5);
  });

  it("відсутність збігів дає 0", () => {
    assert.equal(lexicalScore(["zzz"], "invoice create"), 0);
  });

  it("порожній запит дає 0, а не ділення на нуль", () => {
    assert.equal(lexicalScore([], "будь-що"), 0);
  });

  it("повтор токена в запиті не роздуває оцінку понад 1", () => {
    assert.ok(lexicalScore(["invoice", "invoice"], "invoice") <= 1);
  });
});

describe("scoreChunk", () => {
  const endpoint = { title: "POST /api/merchant/invoice/create", embedText: "створення рахунку", kind: "endpoint" as const };
  const schema = { title: "Схема InvoiceCreate", embedText: "створення рахунку", kind: "schema" as const };

  it("схема штрафується відносно ендпоїнта за інших рівних", () => {
    const e = scoreChunk(endpoint, 0.9, []);
    const s = scoreChunk({ ...schema, title: endpoint.title }, 0.9, []);
    assert.equal(Number((e - s).toFixed(6)), SCHEMA_PENALTY);
  });

  it("лексичний збіг додає рівно свою вагу", () => {
    const without = scoreChunk(endpoint, 0.5, []);
    const with_ = scoreChunk(endpoint, 0.5, ["invoice"]);
    assert.equal(Number((with_ - without).toFixed(6)), LEXICAL_WEIGHT);
  });

  it("лексичний сигнал здатний обігнати вищий вектор", () => {
    const weakVectorExactWord = scoreChunk(endpoint, 0.80, ["invoice", "create"]);
    const strongVectorNoWord = scoreChunk(
      { title: "GET /bank/sync", embedText: "синхронізація", kind: "endpoint" },
      0.87,
      ["invoice", "create"],
    );
    assert.ok(weakVectorExactWord > strongVectorNoWord);
  });
});

describe("truncate", () => {
  it("короткий текст лишається недоторканим", () => {
    assert.equal(truncate("abc", 10), "abc");
  });

  it("текст рівно по межі не ріжеться", () => {
    assert.equal(truncate("abcde", 5), "abcde");
  });

  it("довгий текст ріжеться й отримує позначку", () => {
    const result = truncate("x".repeat(100), 10);
    assert.ok(result.startsWith("x".repeat(10)));
    assert.ok(result.includes("обрізано"));
  });
});

describe("formatContext", () => {
  const hit = (title: string, size: number) => ({ chunk: { title, text: "y".repeat(size) } });

  it("порожній список дає порожній рядок", () => {
    assert.equal(formatContext([]), "");
  });

  it("нумерує джерела з одиниці", () => {
    const out = formatContext([hit("A", 10), hit("B", 10)]);
    assert.ok(out.includes("[Джерело 1: A]"));
    assert.ok(out.includes("[Джерело 2: B]"));
  });

  it("обрізає окремий завеликий чанк", () => {
    const out = formatContext([hit("A", MAX_CHUNK_CHARS * 3)]);
    assert.ok(out.includes("обрізано"));
    assert.ok(out.length < MAX_CHUNK_CHARS * 2);
  });

  it("тримається загального бюджету на багатьох великих чанках", () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit(`H${i}`, MAX_CHUNK_CHARS));
    const out = formatContext(hits);
    // Бюджет плюс невеликий службовий оверхед на заголовки й роздільники.
    assert.ok(out.length < MAX_TOTAL_CHARS + 1000, `довжина ${out.length}`);
  });

  it("верхні джерела потрапляють у контекст раніше за нижні", () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit(`H${i}`, MAX_CHUNK_CHARS));
    const out = formatContext(hits);
    assert.ok(out.includes("H0"));
    assert.ok(!out.includes("H9"));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { degradedAnswer } from "../src/degraded.ts";
import type { Hit } from "../src/retrieve.ts";

function hit(title: string, text: string): Hit {
  return {
    score: 0.9,
    chunk: {
      id: title,
      spec: "acquiring",
      kind: "endpoint",
      title,
      text,
      embedText: title,
      vector: [],
    },
  };
}

const INVOICE = hit(
  "POST /api/merchant/invoice/create",
  [
    "# POST /api/merchant/invoice/create",
    "Специфікація: monobank acquiring",
    "Призначення: Створення рахунку",
    "  - amount (number) [обовʼязкове]",
    "  - ccy (number)",
  ].join("\n"),
);

describe("degradedAnswer", () => {
  it("завжди повертає непорожній текст — навіть без даних", () => {
    const text = degradedAnswer("як створити рахунок", []);
    assert.ok(text.length > 0);
    assert.match(text, /недоступн/);
  });

  it("без знахідок радить переформулювати й цитує питання", () => {
    const text = degradedAnswer("які ліміти?", []);
    assert.match(text, /які ліміти\?/);
    assert.match(text, /переформулювати/);
  });

  it("чесно попереджає, що відповідь не згенерована", () => {
    const text = degradedAnswer("q", [INVOICE]);
    assert.match(text, /не згенерована/);
  });

  it("показує знайдений матеріал", () => {
    const text = degradedAnswer("q", [INVOICE]);
    assert.match(text, /POST \/api\/merchant\/invoice\/create/);
    assert.match(text, /amount/);
  });

  it("прибирає службові рядки чанка", () => {
    const text = degradedAnswer("q", [INVOICE]);
    assert.ok(!text.includes("Специфікація: monobank acquiring"));
  });

  it("вставляє живі дані, якщо вони є", () => {
    const text = degradedAnswer("курс євро", [], "EUR/UAH — купівля 50.8");
    assert.match(text, /EUR\/UAH — купівля 50\.8/);
  });

  it("живі дані рятують відповідь навіть без знахідок у документації", () => {
    const text = degradedAnswer("курс євро", [], "EUR/UAH — 50.8");
    assert.ok(!text.includes("переформулювати"));
  });

  it("бере не більше трьох джерел, щоб відповідь лишалась читаною", () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit(`Джерело${i}`, `текст ${i}`));
    const text = degradedAnswer("q", hits);

    assert.match(text, /Джерело0/);
    assert.ok(!text.includes("Джерело5"));
  });

  it("обрізає надто довгий чанк по рядках", () => {
    const long = hit("Довгий", Array.from({ length: 100 }, (_, i) => `рядок ${i}`).join("\n"));
    const text = degradedAnswer("q", [long]);

    assert.ok(!text.includes("рядок 50"));
  });

  it("не спотикається об чанк із порожнім текстом", () => {
    const text = degradedAnswer("q", [hit("Порожній", "")]);
    assert.ok(text.length > 0);
  });
});

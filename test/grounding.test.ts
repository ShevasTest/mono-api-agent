import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkGrounding, extractPaths } from "../src/grounding.ts";

const CONTEXT = `[Джерело 1: POST /api/merchant/invoice/create]
Повний URL: https://api.monobank.ua/api/merchant/invoice/create
  - amount (number) [обовʼязкове]
[Джерело 2: GET /api/merchant/invoice/status?invoiceId={invoiceId}]
Повний URL: https://api.monobank.ua/api/merchant/invoice/status
[Джерело 3: GET /personal/statement/{account}/{from}/{to}]`;

describe("extractPaths", () => {
  it("знаходить шляхи всіх трьох просторів імен", () => {
    const paths = extractPaths("/api/merchant/invoice/create та /personal/client-info і /bank/currency");
    assert.deepEqual(paths.sort(), [
      "/api/merchant/invoice/create",
      "/bank/currency",
      "/personal/client-info",
    ]);
  });

  it("не дублює однакові шляхи", () => {
    assert.deepEqual(extractPaths("/bank/currency і ще раз /bank/currency"), ["/bank/currency"]);
  });

  it("захоплює плейсхолдери у фігурних дужках", () => {
    assert.deepEqual(extractPaths("GET /personal/statement/{account}/{from}/{to}"), [
      "/personal/statement/{account}/{from}/{to}",
    ]);
  });

  it("не тягне за собою розділові знаки в кінці", () => {
    assert.deepEqual(extractPaths("викликай /bank/currency."), ["/bank/currency"]);
    assert.deepEqual(extractPaths("шлях /bank/sync, потім далі"), ["/bank/sync"]);
  });

  it("ігнорує сторонні шляхи", () => {
    assert.deepEqual(extractPaths("дивись /docs/readme та /v1/other"), []);
  });

  it("на тексті без шляхів повертає порожньо", () => {
    assert.deepEqual(extractPaths("просто текст без жодних шляхів"), []);
  });
});

describe("checkGrounding", () => {
  it("приймає відповідь, де всі шляхи є в контексті", () => {
    const report = checkGrounding(
      "Створи через POST /api/merchant/invoice/create, статус — GET /api/merchant/invoice/status",
      CONTEXT,
      "як створити рахунок",
    );
    assert.equal(report.grounded, true);
    assert.deepEqual(report.invented, []);
  });

  it("ловить вигаданий ендпоїнт", () => {
    const report = checkGrounding(
      "Використай POST /api/merchant/invoice/refund",
      CONTEXT,
      "як повернути гроші",
    );
    assert.equal(report.grounded, false);
    assert.deepEqual(report.invented, ["/api/merchant/invoice/refund"]);
    assert.equal(report.refinedQuery, "/api/merchant/invoice/refund");
  });

  it("не зважає на регістр", () => {
    const report = checkGrounding("POST /API/Merchant/Invoice/Create", CONTEXT, "q");
    assert.equal(report.grounded, true);
  });

  it("не зважає на хвостову косу", () => {
    const report = checkGrounding("POST /api/merchant/invoice/create/", CONTEXT, "q");
    assert.equal(report.grounded, true);
  });

  it("вважає збігом інакше названий плейсхолдер", () => {
    const report = checkGrounding("GET /personal/statement/{acc}/{a}/{b}", CONTEXT, "q");
    assert.equal(report.grounded, true);
  });

  it("приймає шлях, що є префіксом відомого", () => {
    const report = checkGrounding("дивись /api/merchant/invoice", CONTEXT, "q");
    assert.equal(report.grounded, true);
  });

  it("розпізнає зізнання моделі, що даних бракує", () => {
    for (const admission of [
      "У контексті немає інформації про ліміти.",
      "В контексті відсутні дані щодо цього.",
      "Бракує даних для повної відповіді.",
      "Не вказано у специфікації.",
      "Немає інформації про рейт-ліміти.",
    ]) {
      const report = checkGrounding(admission, CONTEXT, "які ліміти?");
      assert.equal(report.grounded, false, `не спрацювало на: ${admission}`);
      assert.equal(report.admitsGap, true);
    }
  });

  it("для зізнання без вигаданих шляхів шукає за початковим питанням", () => {
    const report = checkGrounding("У контексті немає даних.", CONTEXT, "які ліміти?");
    assert.equal(report.refinedQuery, "які ліміти?");
  });

  it("не приймає звичайний текст за зізнання", () => {
    const report = checkGrounding(
      "Поле amount обовʼязкове, а comment — ні. Дивись POST /api/merchant/invoice/create",
      CONTEXT,
      "q",
    );
    assert.equal(report.grounded, true);
    assert.equal(report.admitsGap, false);
  });

  it("порожня відповідь вважається заземленою — судити нема про що", () => {
    const report = checkGrounding("", CONTEXT, "q");
    assert.equal(report.grounded, true);
  });

  it("порожній контекст робить будь-який шлях вигаданим", () => {
    const report = checkGrounding("POST /api/merchant/invoice/create", "", "q");
    assert.equal(report.grounded, false);
    assert.deepEqual(report.invented, ["/api/merchant/invoice/create"]);
  });

  it("перелічує всі вигадані шляхи, а не лише перший", () => {
    const report = checkGrounding(
      "Спочатку /api/merchant/foo, потім /personal/bar",
      CONTEXT,
      "q",
    );
    assert.equal(report.invented.length, 2);
  });
});

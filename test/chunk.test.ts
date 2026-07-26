import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkSpec } from "../src/chunk.ts";
import type { OpenApiSpec } from "../src/specs.ts";

const spec: OpenApiSpec = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.monobank.ua" }],
  paths: {
    "/api/merchant/invoice/create": {
      post: {
        summary: "Створення рахунку",
        description: "Створює   рахунок\nдля оплати",
        tags: ["Мерчант"],
        security: [{ "X-Token": [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InvoiceRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "успіх",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/InvoiceResponse" },
              },
            },
          },
          "400": { description: "помилка" },
        },
      },
    },
    "/api/merchant/statement": {
      get: {
        summary: "Виписка",
        parameters: [
          { name: "from", in: "query", required: true, schema: { type: "number" }, example: 1 },
          { name: "to", in: "query", schema: { type: "number" } },
        ],
        responses: { "200": { description: "ок" } },
      },
    },
  },
  components: {
    schemas: {
      InvoiceRequest: {
        type: "object",
        required: ["amount"],
        properties: {
          amount: { type: "number", description: "сума в копійках", example: 4200 },
          ccy: { type: "number", enum: [980, 840] },
          merchantPaymInfo: { $ref: "#/components/schemas/PaymInfo" },
        },
      },
      PaymInfo: {
        type: "object",
        properties: {
          reference: { type: "string" },
          basketOrder: { type: "array", items: { $ref: "#/components/schemas/BasketItem" } },
        },
      },
      BasketItem: {
        type: "object",
        properties: { name: { type: "string" }, qty: { type: "number" } },
      },
      InvoiceResponse: {
        type: "object",
        properties: { invoiceId: { type: "string" }, pageUrl: { type: "string" } },
      },
      Recursive: {
        type: "object",
        properties: { child: { $ref: "#/components/schemas/Recursive" } },
      },
      Combined: {
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "number" } } },
        ],
      },
    },
  },
};

const chunks = chunkSpec("acquiring", spec);
const create = chunks.find((c) => c.title === "POST /api/merchant/invoice/create");
const statement = chunks.find((c) => c.title === "GET /api/merchant/statement");

describe("chunkSpec — ендпоїнти", () => {
  it("робить по чанку на кожну пару шлях+метод", () => {
    const endpoints = chunks.filter((c) => c.kind === "endpoint");
    assert.equal(endpoints.length, 2);
  });

  it("будує повний URL із серверів", () => {
    assert.match(create!.text, /https:\/\/api\.monobank\.ua\/api\/merchant\/invoice\/create/);
  });

  it("схлопує переноси й зайві пробіли в описі", () => {
    assert.match(create!.text, /Створює рахунок для оплати/);
  });

  it("переносить теги й авторизацію", () => {
    assert.match(create!.text, /Розділ: Мерчант/);
    assert.match(create!.text, /Авторизація: X-Token/);
  });

  it("розкриває $ref тіла запиту до конкретних полів", () => {
    assert.match(create!.text, /amount \(number\) \[обовʼязкове\]/);
    assert.match(create!.text, /сума в копійках/);
    assert.match(create!.text, /приклад: 4200/);
  });

  it("перелічує допустимі значення enum", () => {
    assert.match(create!.text, /допустимі: 980, 840/);
  });

  it("спускається у вкладені $ref і масиви", () => {
    assert.match(create!.text, /reference/);
    assert.match(create!.text, /basketOrder/);
  });

  it("описує відповіді разом із кодами", () => {
    assert.match(create!.text, /200 — успіх/);
    assert.match(create!.text, /400 — помилка/);
    assert.match(create!.text, /invoiceId/);
  });

  it("описує параметри запиту з ознакою обовʼязковості", () => {
    assert.match(statement!.text, /from \(in: query\) \[обовʼязковий\]/);
    assert.match(statement!.text, /to \(in: query\)/);
  });
});

describe("chunkSpec — текст для ембедингу", () => {
  it("помітно коротший за повний текст", () => {
    assert.ok(
      create!.embedText.length < create!.text.length / 2,
      `embedText ${create!.embedText.length} vs text ${create!.text.length}`,
    );
  });

  it("містить призначення методу", () => {
    assert.match(create!.embedText, /Створення рахунку/);
  });

  it("містить імена полів верхнього рівня", () => {
    assert.match(create!.embedText, /amount/);
    assert.match(create!.embedText, /invoiceId/);
  });

  it("не тягне вкладені поля глибоких схем", () => {
    // basketOrder — поле другого рівня, у пошуковий текст іти не має,
    // інакше вектор знову почне описувати схему замість призначення.
    assert.ok(!create!.embedText.includes("qty"));
  });

  it("не порожній для жодного чанка", () => {
    for (const chunk of chunks) {
      assert.ok(chunk.embedText.trim().length > 0, `порожній embedText у ${chunk.title}`);
    }
  });
});

describe("chunkSpec — схеми", () => {
  it("робить окремий чанк на кожну іменовану схему", () => {
    const names = chunks.filter((c) => c.kind === "schema").map((c) => c.title);
    assert.ok(names.includes("Схема InvoiceRequest"));
    assert.ok(names.includes("Схема BasketItem"));
  });

  it("не зациклюється на рекурсивній схемі", () => {
    const recursive = chunks.find((c) => c.title === "Схема Recursive");
    assert.ok(recursive);
    assert.match(recursive.text, /рекурсія/);
  });

  it("зводить allOf у єдиний список полів", () => {
    const combined = chunks.find((c) => c.title === "Схема Combined");
    assert.ok(combined);
    assert.match(combined.text, /- a/);
    assert.match(combined.text, /- b/);
  });
});

describe("chunkSpec — межові випадки", () => {
  it("порожня специфікація дає порожній список", () => {
    assert.deepEqual(chunkSpec("порожня", {}), []);
  });

  it("шлях без підтримуваних методів ігнорується", () => {
    const odd: OpenApiSpec = { paths: { "/x": { options: { summary: "нема" } } } };
    assert.equal(chunkSpec("x", odd).length, 0);
  });

  it("непідйомний $ref не валить чанкінг", () => {
    const broken: OpenApiSpec = {
      paths: {
        "/x": {
          get: {
            summary: "зламаний",
            responses: {
              "200": {
                description: "d",
                content: { "application/json": { schema: { $ref: "#/nope/Missing" } } },
              },
            },
          },
        },
      },
    };
    const result = chunkSpec("x", broken);
    assert.equal(result.length, 1);
    assert.match(result[0]!.text, /GET \/x/);
  });

  it("ідентифікатори чанків унікальні", () => {
    const ids = chunks.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("назва специфікації потрапляє в кожен чанк", () => {
    for (const chunk of chunks) assert.equal(chunk.spec, "acquiring");
  });

  it("працює без блоку servers", () => {
    const noServers: OpenApiSpec = {
      paths: { "/x": { get: { summary: "s", responses: {} } } },
    };
    assert.match(chunkSpec("x", noServers)[0]!.text, /https:\/\/api\.monobank\.ua\/x/);
  });
});

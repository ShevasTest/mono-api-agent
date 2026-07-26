import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CACHE_TTL_MS, CurrencyTool, formatRates, type CurrencyRate } from "../src/tools.ts";

const USD: CurrencyRate = {
  currencyCodeA: 840,
  currencyCodeB: 980,
  date: 1_700_000_000,
  rateBuy: 44.63,
  rateSell: 45.03,
};

const GBP_CROSS: CurrencyRate = {
  currencyCodeA: 826,
  currencyCodeB: 980,
  date: 1_700_000_000,
  rateCross: 60.11,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeTool(responder: () => Response | Promise<Response> | never) {
  let clock = 0;
  let calls = 0;
  const tool = new CurrencyTool({
    fetch: (async () => {
      calls += 1;
      return responder();
    }) as unknown as typeof fetch,
    now: () => clock,
  });
  return {
    tool,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("formatRates", () => {
  it("показує купівлю й продаж", () => {
    const text = formatRates([USD]);
    assert.match(text, /USD\/UAH — купівля 44\.63, продаж 45\.03/);
  });

  it("падає назад на крос-курс, коли купівлі й продажу нема", () => {
    assert.match(formatRates([GBP_CROSS]), /GBP\/UAH — крос-курс 60\.11/);
  });

  it("відкидає пари не до гривні", () => {
    const eurUsd: CurrencyRate = { currencyCodeA: 978, currencyCodeB: 840, date: 1, rateCross: 1.1 };
    assert.match(formatRates([eurUsd]), /не знайшлось/);
  });

  it("відкидає невідомі валюти", () => {
    const unknown: CurrencyRate = { currencyCodeA: 9999, currencyCodeB: 980, date: 1, rateCross: 5 };
    assert.match(formatRates([unknown]), /не знайшлось/);
  });

  it("відкидає запис зовсім без курсів", () => {
    const empty: CurrencyRate = { currencyCodeA: 840, currencyCodeB: 980, date: 1 };
    assert.match(formatRates([empty]), /не знайшлось/);
  });

  it("порожній масив не ламає форматування", () => {
    assert.match(formatRates([]), /не знайшлось/);
  });

  it("показує кілька валют рядками", () => {
    const text = formatRates([USD, GBP_CROSS]);
    assert.equal(text.split("\n").length, 3);
  });
});

describe("CurrencyTool", () => {
  it("віддає відформатовані курси", async () => {
    const { tool } = makeTool(() => jsonResponse([USD]));
    assert.match(await tool.getRates(), /USD\/UAH/);
  });

  it("другий виклик у межах TTL бере кеш і не ходить у мережу", async () => {
    const h = makeTool(() => jsonResponse([USD]));

    await h.tool.getRates();
    h.advance(CACHE_TTL_MS - 1);
    await h.tool.getRates();

    assert.equal(h.calls(), 1);
  });

  it("після TTL іде в мережу знову", async () => {
    const h = makeTool(() => jsonResponse([USD]));

    await h.tool.getRates();
    h.advance(CACHE_TTL_MS + 1);
    await h.tool.getRates();

    assert.equal(h.calls(), 2);
  });

  it("пояснює 429 по-людськи", async () => {
    const { tool } = makeTool(() => new Response("", { status: 429 }));
    assert.match(await tool.getRates(), /429.*один запит на 60 секунд/s);
  });

  it("невдалу відповідь не кешує", async () => {
    let status = 500;
    let clock = 0;
    let calls = 0;
    const tool = new CurrencyTool({
      fetch: (async () => {
        calls += 1;
        return status === 500 ? new Response("", { status: 500 }) : jsonResponse([USD]);
      }) as unknown as typeof fetch,
      now: () => clock,
    });

    assert.match(await tool.getRates(), /HTTP 500/);
    status = 200;
    assert.match(await tool.getRates(), /USD\/UAH/);
    assert.equal(calls, 2);
  });

  it("мережевий збій не кидає виняток, а пояснює проблему", async () => {
    const { tool } = makeTool(() => {
      throw new Error("ENOTFOUND");
    });
    assert.match(await tool.getRates(), /не вдалося зв'язатися.*ENOTFOUND/s);
  });

  it("не-JSON у відповіді не валить інструмент", async () => {
    const { tool } = makeTool(() => new Response("<html>помилка</html>", { status: 200 }));
    assert.match(await tool.getRates(), /не JSON/);
  });

  it("несподіваний формат JSON не валить інструмент", async () => {
    const { tool } = makeTool(() => jsonResponse({ error: "щось" }));
    assert.match(await tool.getRates(), /несподіваний формат/);
  });

  it("clearCache змушує сходити в мережу", async () => {
    const h = makeTool(() => jsonResponse([USD]));

    await h.tool.getRates();
    h.tool.clearCache();
    await h.tool.getRates();

    assert.equal(h.calls(), 2);
  });
});

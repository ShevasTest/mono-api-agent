import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { instrument, metrics } from "../src/metrics.ts";

beforeEach(() => metrics.reset());

describe("metrics", () => {
  it("порожні метрики повідомляють про це, а не падають", () => {
    assert.match(metrics.report(), /метрик нема/);
  });

  it("рахує час вузла", async () => {
    await instrument("route", async () => "готово")({});
    assert.match(metrics.report(), /route/);
    assert.equal(metrics.callCount, 0);
  });

  it("прив'язує виклик моделі до поточного вузла", async () => {
    await instrument("generate", async () => {
      metrics.recordCall({ model: "m", promptTokens: 10, completionTokens: 5, durationMs: 100 });
      return null;
    })({});

    assert.equal(metrics.totalTokens, 15);
    assert.equal(metrics.llmMs, 100);
    assert.match(metrics.report(), /generate.*1 виклик\(и\), 15 токенів/s);
  });

  it("не подвоює токени, коли вузол з тим самим іменем трапляється двічі", async () => {
    // Саме цей дефект був у першій версії: групування по імені показувало
    // токени другого проходу і в рядку першого.
    const node = instrument("generate", async () => {
      metrics.recordCall({ model: "m", promptTokens: 100, completionTokens: 0, durationMs: 10 });
      return null;
    });

    await node({});
    await node({});

    assert.equal(metrics.totalTokens, 200);

    const rows = metrics
      .report()
      .split("\n")
      .filter((line) => line.includes("generate"));

    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row, /1 виклик\(и\), 100 токенів/, `рядок подвоївся: ${row}`);
    }
  });

  it("вузол без викликів моделі не отримує приписку про токени", async () => {
    await instrument("retrieve", async () => null)({});
    const row = metrics
      .report()
      .split("\n")
      .find((line) => line.includes("retrieve"));

    assert.ok(row);
    assert.ok(!row.includes("виклик"));
  });

  it("міряє вузол навіть тоді, коли він кинув помилку", async () => {
    const boom = instrument("generate", async () => {
      throw new Error("впало");
    });

    await assert.rejects(() => boom({}));
    assert.match(metrics.report(), /generate/);
  });

  it("reset очищає все", async () => {
    await instrument("route", async () => {
      metrics.recordCall({ model: "m", promptTokens: 1, completionTokens: 1, durationMs: 1 });
      return null;
    })({});

    metrics.reset();

    assert.equal(metrics.totalTokens, 0);
    assert.equal(metrics.callCount, 0);
    assert.match(metrics.report(), /метрик нема/);
  });

  it("підсумковий рядок сходиться з сумою вузлів", async () => {
    await instrument("a", async () => {
      metrics.recordCall({ model: "m", promptTokens: 7, completionTokens: 3, durationMs: 50 });
      return null;
    })({});
    await instrument("b", async () => {
      metrics.recordCall({ model: "m", promptTokens: 1, completionTokens: 1, durationMs: 20 });
      return null;
    })({});

    assert.equal(metrics.totalTokens, 12);
    assert.equal(metrics.llmMs, 70);
    assert.match(metrics.report(), /викликів моделі 2 · токенів 12/);
  });
});

describe("ізоляція лічильників між паралельними проходами", () => {
  it("два одночасні проходи не перемішують кроки й токени", async () => {
    // Раніше лічильники були одним об'єктом на процес: два паралельні
    // ask() складали свої кроки в спільну купу, і звіт ставав вигадкою.
    const run = (node: string, tokens: number, delayMs: number) =>
      metrics.runIsolated(async () => {
        await instrument(node, async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          metrics.recordCall({ model: "m", promptTokens: tokens, completionTokens: 0, durationMs: 1 });
          return null;
        })({});
        return { tokens: metrics.totalTokens, report: metrics.report() };
      });

    const [first, second] = await Promise.all([run("alpha", 100, 20), run("beta", 7, 5)]);

    assert.equal(first!.tokens, 100);
    assert.equal(second!.tokens, 7);
    assert.ok(first!.report.includes("alpha") && !first!.report.includes("beta"));
    assert.ok(second!.report.includes("beta") && !second!.report.includes("alpha"));
  });

  it("ізольований прохід не чіпає зовнішні лічильники", async () => {
    metrics.reset();
    await instrument("зовні", async () => {
      metrics.recordCall({ model: "m", promptTokens: 5, completionTokens: 0, durationMs: 1 });
      return null;
    })({});

    await metrics.runIsolated(async () => {
      metrics.recordCall({ model: "m", promptTokens: 999, completionTokens: 0, durationMs: 1 });
    });

    assert.equal(metrics.totalTokens, 5);
  });

  it("кожен ізольований прохід нумерує кроки з нуля", async () => {
    const stepsOf = () =>
      metrics.runIsolated(async () => {
        await instrument("a", async () => null)({});
        await instrument("b", async () => null)({});
        return metrics.report();
      });

    const first = await stepsOf();
    const second = await stepsOf();

    assert.equal(first.split("\n").length, second.split("\n").length);
  });
});

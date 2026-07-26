import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyDotEnv, parseDotEnv } from "../src/env.ts";

describe("parseDotEnv", () => {
  it("читає прості пари", () => {
    assert.deepEqual(parseDotEnv("A=1\nB=2"), { A: "1", B: "2" });
  });

  it("ігнорує коментарі та порожні рядки", () => {
    assert.deepEqual(parseDotEnv("# коментар\n\n  \nA=1\n#B=2"), { A: "1" });
  });

  it("обрізає пробіли навколо ключа й значення", () => {
    assert.deepEqual(parseDotEnv("  A  =  1  "), { A: "1" });
  });

  it("зберігає символи '=' усередині значення", () => {
    assert.deepEqual(parseDotEnv("URL=https://x.dev/?a=1&b=2"), {
      URL: "https://x.dev/?a=1&b=2",
    });
  });

  it("знімає парні лапки", () => {
    assert.deepEqual(parseDotEnv(`A="1"\nB='2'`), { A: "1", B: "2" });
  });

  it("не чіпає непарні лапки — це частина значення", () => {
    assert.deepEqual(parseDotEnv(`A="1\nB=it's`), { A: `"1`, B: "it's" });
  });

  it("зберігає апостроф усередині значення в лапках", () => {
    assert.deepEqual(parseDotEnv(`A="it's fine"`), { A: "it's fine" });
  });

  it("пропускає рядки без '=' і з порожнім ключем", () => {
    assert.deepEqual(parseDotEnv("СМІТТЯ\n=значення\nA=1"), { A: "1" });
  });

  it("дозволяє порожнє значення", () => {
    assert.deepEqual(parseDotEnv("GROQ_API_KEY="), { GROQ_API_KEY: "" });
  });

  it("останнє входження ключа перемагає", () => {
    assert.deepEqual(parseDotEnv("A=1\nA=2"), { A: "2" });
  });

  it("не спотикається об CRLF", () => {
    assert.deepEqual(parseDotEnv("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
  });

  it("порожній файл дає порожній об'єкт", () => {
    assert.deepEqual(parseDotEnv(""), {});
  });
});

describe("applyDotEnv", () => {
  it("ставить значення, якщо в оточенні його немає", () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = applyDotEnv({ A: "1" }, { env });

    assert.equal(env.A, "1");
    assert.deepEqual(result.applied, ["A"]);
    assert.deepEqual(result.overridden, []);
  });

  it("файл перекриває застаріле значення з оточення", () => {
    // Саме цей випадок ламав усе: у шелі лежав старий GROQ_API_KEY тієї ж
    // довжини, і .env мовчки програвав йому, даючи 401 на кожному запиті.
    const env = { GROQ_API_KEY: "старий" } as NodeJS.ProcessEnv;
    const result = applyDotEnv({ GROQ_API_KEY: "новий" }, { env });

    assert.equal(env.GROQ_API_KEY, "новий");
    assert.deepEqual(result.overridden, ["GROQ_API_KEY"]);
  });

  it("перекриття явно повідомляється — мовчки затінювати конфіг не можна", () => {
    const env = { A: "старе", B: "те саме" } as NodeJS.ProcessEnv;
    const result = applyDotEnv({ A: "нове", B: "те саме", C: "новий" }, { env });

    assert.deepEqual(result.overridden, ["A"]);
    assert.deepEqual(result.applied.sort(), ["A", "C"]);
  });

  it("однакове значення не вважається перекриттям", () => {
    const env = { A: "1" } as NodeJS.ProcessEnv;
    const result = applyDotEnv({ A: "1" }, { env });

    assert.deepEqual(result.overridden, []);
    assert.deepEqual(result.applied, []);
  });

  it("override:false повертає класичну поведінку dotenv", () => {
    const env = { A: "з оточення" } as NodeJS.ProcessEnv;
    const result = applyDotEnv({ A: "з файлу" }, { env, override: false });

    assert.equal(env.A, "з оточення");
    assert.deepEqual(result.overridden, []);
  });

  it("override:false усе одно ставить відсутні ключі", () => {
    const env = {} as NodeJS.ProcessEnv;
    applyDotEnv({ A: "з файлу" }, { env, override: false });

    assert.equal(env.A, "з файлу");
  });

  it("порожній набір нічого не змінює", () => {
    const env = { A: "1" } as NodeJS.ProcessEnv;
    const result = applyDotEnv({}, { env });

    assert.equal(env.A, "1");
    assert.deepEqual(result.applied, []);
  });
});

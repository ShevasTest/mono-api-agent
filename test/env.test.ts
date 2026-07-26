import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDotEnv } from "../src/env.ts";

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

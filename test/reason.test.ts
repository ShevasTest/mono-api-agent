import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { llm } from "../src/llm.ts";
import { isFakeMode, reason, reasonJson } from "../src/reason.ts";

const TOUCHED = [
  "MONO_AGENT_FAKE_LLM",
  "MONO_AGENT_FAKE_UNGROUNDED",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  // Жоден тест не має права піти в мережу.
  for (const key of TOUCHED) delete process.env[key];
  llm.reset();
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  llm.reset();
});

describe("офлайн-режим", () => {
  it("вимкнений за замовчуванням", () => {
    assert.equal(isFakeMode(), false);
  });

  it("вмикається змінною оточення", () => {
    process.env.MONO_AGENT_FAKE_LLM = "1";
    assert.equal(isFakeMode(), true);
  });

  it("будь-яке інше значення не вмикає його", () => {
    process.env.MONO_AGENT_FAKE_LLM = "true";
    assert.equal(isFakeMode(), false);
  });

  it("reason повертає заглушку без походу в мережу", async () => {
    process.env.MONO_AGENT_FAKE_LLM = "1";
    const result = await reason({ system: "s", user: "довгий контекст" });

    assert.match(result.text, /офлайн-заглушка/);
    assert.equal(result.via, "offline-stub");
  });

  it("reasonJson бере значення за замовчуванням", async () => {
    process.env.MONO_AGENT_FAKE_LLM = "1";
    const result = await reasonJson({ system: "s", user: "u" }, { needsLiveData: false });

    assert.deepEqual(result.value, { needsLiveData: false });
    assert.equal(result.degraded, false);
  });

  it("окремий прапорець змушує самоперевірку сказати «бракує»", async () => {
    process.env.MONO_AGENT_FAKE_LLM = "1";
    process.env.MONO_AGENT_FAKE_UNGROUNDED = "1";

    const result = await reasonJson({ system: "s", user: "u" }, { grounded: true });

    assert.equal((result.value as { grounded: boolean }).grounded, false);
  });

  it("прапорець «бракує» не чіпає інші JSON-виклики", async () => {
    process.env.MONO_AGENT_FAKE_LLM = "1";
    process.env.MONO_AGENT_FAKE_UNGROUNDED = "1";

    const result = await reasonJson({ system: "s", user: "u" }, { needsLiveData: false });

    assert.deepEqual(result.value, { needsLiveData: false });
  });
});

describe("деградація без ключів", () => {
  it("reasonJson не кидає помилку, а віддає значення за замовчуванням", async () => {
    const result = await reasonJson({ system: "s", user: "u" }, { needsLiveData: false });

    assert.deepEqual(result.value, { needsLiveData: false });
    assert.equal(result.degraded, true, "має бути позначено як деградацію");
  });

  it("reason навпаки прокидає помилку — щоб граф зміг зібрати відповідь сам", async () => {
    await assert.rejects(() => reason({ system: "s", user: "u" }), /жодна модель не відповіла/);
  });
});

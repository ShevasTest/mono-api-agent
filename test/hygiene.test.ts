/**
 * Гігієна репозиторію.
 *
 * Ці перевірки з'явилися після реального випадку: у тесті опинилися
 * буквальні керівні байти, зокрема NUL. Файл через це вважався бінарним —
 * він мовчки випадав із grep, із пошуку по проєкту й із будь-якого ревʼю.
 * Тести при цьому проходили, тобто звичайна перевірка проблему не бачила.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

function sourceFiles(): string[] {
  return ["src", "test"].flatMap((dir) =>
    readdirSync(path.join(ROOT, dir))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(dir, name)),
  );
}

describe("гігієна вихідників", () => {
  it("жоден файл не містить буквальних керівних байтів", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const bytes = readFileSync(path.join(ROOT, file));
      const bad = [...bytes].some((b) => b < 32 && b !== 9 && b !== 10 && b !== 13);
      if (bad) offenders.push(file);
    }

    assert.deepEqual(
      offenders,
      [],
      `керівні байти роблять файл бінарним для інструментів: ${offenders.join(", ")}. ` +
        "Використовуй escape-послідовності (\\u0000), а не самі символи.",
    );
  });

  it("немає позначок незавершеної роботи", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      // Цей файл пропускаємо: самі позначки перелічені в його регулярному
      // виразі, тож перевірка спрацьовувала б на собі.
      if (file === path.join("test", "hygiene.test.ts")) continue;

      const text = readFileSync(path.join(ROOT, file), "utf8");
      if (/\b(TODO|FIXME|XXX|HACK)\b/.test(text)) offenders.push(file);
    }

    assert.deepEqual(offenders, []);
  });

  it("у бібліотечних модулях нема друку в консоль", () => {
    // Точки входу друкувати мусять — решта модулів має повертати дані,
    // а не вирішувати за викликача, що і куди виводити.
    const entryPoints = new Set([
      "src/cli.ts",
      "src/ingest.ts",
      "src/bench.ts",
      "src/doctor.ts",
      "src/search-cli.ts",
    ]);

    const offenders = sourceFiles()
      .filter((file) => file.startsWith("src/") && !entryPoints.has(file))
      .filter((file) => /console\.(log|info|warn|error)/.test(readFileSync(path.join(ROOT, file), "utf8")));

    assert.deepEqual(offenders, []);
  });

  it(".env.example описує всі змінні, які читає код", () => {
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");

    for (const variable of [
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "GROQ_API_KEY_2",
      "OPENROUTER_API_KEY_2",
      "MONO_AGENT_FAKE_LLM",
    ]) {
      assert.ok(example.includes(variable), `у .env.example нема ${variable}`);
    }
  });

  it("секрети не потрапляють у вихідники", () => {
    // Груба, але дієва перевірка: справжні ключі мають упізнавані префікси.
    const pattern = /\b(gsk_[A-Za-z0-9]{20,}|sk-or-v1-[a-f0-9]{32,})\b/;
    const offenders = sourceFiles().filter((file) =>
      pattern.test(readFileSync(path.join(ROOT, file), "utf8")),
    );

    assert.deepEqual(offenders, [], "схоже на справжній ключ у коді");
  });
});

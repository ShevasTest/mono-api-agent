/**
 * CLI: npm run ask -- "як створити інвойс і перевірити його статус?"
 *
 * Прапорець --trace показує, як граф ходив по вузлах.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { ask } from "./agent.ts";
import { resolveProvider } from "./llm.ts";

/** Мінімальний .env-лоадер — щоб не тягти залежність заради п'яти рядків. */
async function loadDotEnv(file = ".env") {
  if (!existsSync(file)) return;

  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  await loadDotEnv();

  const args = process.argv.slice(2);
  const showTrace = args.includes("--trace");
  const question = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  if (!question) {
    console.error('Використання: npm run ask -- "твоє питання" [--trace]');
    process.exit(1);
  }

  const provider = resolveProvider();
  console.log(`провайдер: ${provider.name} / ${provider.model}\n`);

  const result = await ask(question);

  console.log(result.answer);

  console.log(`\n— джерела (${result.sources.length}):`);
  for (const source of result.sources) console.log(`  · ${source}`);

  if (showTrace) {
    console.log(`\n— хід графа (проходів пошуку: ${result.attempts}):`);
    for (const step of result.trace) console.log(`  → ${step}`);
  }
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});

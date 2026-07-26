/**
 * CLI: npm run ask -- "як створити інвойс і перевірити його статус?"
 *
 * Прапорець --trace показує, як граф ходив по вузлах.
 */
import { ask } from "./agent.ts";
import { loadDotEnv } from "./env.ts";
import { llm } from "./llm.ts";
import { isFakeMode } from "./reason.ts";
import { JSON_CHAIN, PROSE_CHAIN, specLabel } from "./providers.ts";

async function main() {
  await loadDotEnv();

  const args = process.argv.slice(2);
  const showTrace = args.includes("--trace");
  const question = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  if (!question) {
    console.error('Використання: npm run ask -- "твоє питання" [--trace]');
    process.exit(1);
  }

  if (isFakeMode()) {
    console.log("режим: офлайн (модель не викликається)\n");
  } else if (!llm.hasAnyKey()) {
    console.log(
      "⚠️  нема жодного ключа (GROQ_API_KEY / OPENROUTER_API_KEY) — " +
        "відповідь буде зібрана з документації без моделі\n",
    );
  } else {
    const available = llm.availableModels(PROSE_CHAIN);
    console.log(
      `доступно моделей: ${available.length} із ${PROSE_CHAIN.length}` +
        (available[0] ? `, перша в черзі — ${specLabel(available[0])}` : "") +
        `\n(JSON-ланцюжок: ${llm.availableModels(JSON_CHAIN).length} із ${JSON_CHAIN.length})\n`,
    );
  }

  const result = await ask(question);

  console.log(result.answer);

  console.log(`\n— джерела (${result.sources.length}):`);
  for (const source of result.sources) console.log(`  · ${source}`);

  if (showTrace) {
    console.log(`\n— хід графа (проходів пошуку: ${result.attempts}):`);
    for (const step of result.trace) console.log(`  → ${step}`);

    console.log(`\n— вартість проходу:`);
    console.log(result.metrics);
  }
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});

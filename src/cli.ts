/**
 * CLI: npm run ask -- "як створити інвойс і перевірити його статус?"
 *
 * Прапорець --trace показує, як граф ходив по вузлах і скільки це коштувало.
 *
 * Вивід влаштований так, щоб відповідь було видно з першого погляду:
 * усе службове приглушене, акцент лишається на тексті, який людина
 * прийшла прочитати.
 */
import { ask } from "./agent.ts";
import { loadDotEnv } from "./env.ts";
import { llm } from "./llm.ts";
import { JSON_CHAIN, PROSE_CHAIN, specLabel } from "./providers.ts";
import { isFakeMode } from "./reason.ts";
import { CURRENCY_URL } from "./tools.ts";
import { Ui } from "./ui.ts";

const ui = new Ui();

function printPreamble(overridden: string[]) {
  for (const key of overridden) {
    console.log(ui.dim(`  .env перекрив ${key} — у шелі лежало інше значення`));
  }

  if (isFakeMode()) {
    console.log(ui.warn("  офлайн-режим: модель не викликається"));
    return;
  }

  if (!llm.hasAnyKey()) {
    console.log(
      ui.warn("  ключів нема — відповідь буде зібрана з документації без моделі"),
    );
    return;
  }

  const prose = llm.availableModels(PROSE_CHAIN);
  const json = llm.availableModels(JSON_CHAIN);
  const first = prose[0];

  console.log(
    ui.dim(
      `  ключів ${llm.configuredKeyCount()} · моделей ${prose.length}/${PROSE_CHAIN.length} ` +
        `(JSON ${json.length}/${JSON_CHAIN.length})` +
        (first ? ` · перша в черзі ${specLabel(first)}` : ""),
    ),
  );
}

async function main() {
  const env = await loadDotEnv();

  const args = process.argv.slice(2);
  const showTrace = args.includes("--trace");
  const question = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  if (!question) {
    console.error(ui.err('Використання: npm run ask -- "твоє питання" [--trace]'));
    process.exit(1);
  }

  printPreamble(env.overridden);

  const result = await ask(question);

  console.log(ui.section("Відповідь"));
  console.log();
  console.log(ui.renderAnswer(result.answer));

  // У гілці живих даних відповідь приходить із виклику API, а не з
  // документації — показувати знайдені чанки як джерело було б оманою.
  console.log(ui.section("Джерела"));
  if (result.usedLiveData) {
    console.log(`  ${ui.ok("●")} живий виклик ${ui.accent(CURRENCY_URL)}`);
    console.log(ui.dim(`    (додатково знайдено в документації: ${result.sources.length})`));
  } else {
    for (const source of result.sources) {
      console.log(`  ${ui.dim("·")} ${ui.accent(source)}`);
    }
  }

  if (result.degraded) {
    console.log(ui.warn("\n  ⚠ відповідь зібрана без моделі — жодна не була доступна"));
  }

  if (showTrace) {
    console.log(ui.section(`Хід графа (проходів пошуку: ${result.attempts})`));
    for (const step of result.trace) {
      const [node, ...rest] = step.split(":");
      console.log(`  ${ui.dim("→")} ${ui.bold(node ?? "")}${rest.length ? ":" : ""}${ui.dim(rest.join(":"))}`);
    }

    console.log(ui.section("Вартість проходу"));
    console.log(ui.dim(result.metrics));
  }

  console.log();
}

main().catch((error) => {
  console.error(ui.err(`✗ ${error instanceof Error ? error.message : error}`));
  process.exit(1);
});

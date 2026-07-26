/**
 * Перевірка стану: npm run doctor
 *
 * Індекс — це знімок чужої документації. monobank її оновлює, і застарілий
 * індекс зовні не відрізняється від свіжого: агент так само впевнено
 * відповідає, тільки за схемою, якої вже немає. Ця команда порівнює відбитки
 * специфікацій у мережі з тими, що зашиті в індекс.
 */
import { loadDotEnv } from "./env.ts";
import { indexAgeDays, isStale, STALE_AFTER_DAYS } from "./index-store.ts";
import { llm } from "./llm.ts";
import { JSON_CHAIN, PROSE_CHAIN } from "./providers.ts";
import { loadIndex } from "./retrieve.ts";
import { loadAllSpecs, specHash } from "./specs.ts";

async function main() {
  await loadDotEnv();

  let problems = 0;

  console.log("── ключі");
  const keyCount = llm.configuredKeyCount();
  if (keyCount === 0) {
    console.log("  ✗ жодного ключа — агент працюватиме лише в режимі без моделі");
    problems += 1;
  } else {
    console.log(`  ✓ налаштовано ключів: ${keyCount}`);
    console.log(
      `    моделей доступно: проза ${llm.availableModels(PROSE_CHAIN).length}/${PROSE_CHAIN.length}` +
        `, JSON ${llm.availableModels(JSON_CHAIN).length}/${JSON_CHAIN.length}`,
    );
  }

  console.log("\n── індекс");
  let index;
  try {
    index = await loadIndex();
  } catch (error) {
    console.log(`  ✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const age = indexAgeDays(index);
  console.log(`  ✓ чанків: ${index.chunks.length}, модель ембедингів: ${index.model}`);
  console.log(`    зібрано: ${index.builtAt} (${age.toFixed(1)} дн. тому)`);

  if (isStale(index)) {
    console.log(`  ⚠ старший за ${STALE_AFTER_DAYS} днів — варто перезібрати`);
    problems += 1;
  }

  console.log("\n── специфікації monobank");
  if (!index.specHashes) {
    console.log("  ⚠ індекс зібрано до появи відбитків — перезбери, щоб перевірка запрацювала");
    problems += 1;
  } else {
    const live = await loadAllSpecs(true);
    for (const { source, spec } of live) {
      const now = specHash(spec);
      const stored = index.specHashes[source.name];

      if (stored === now) {
        console.log(`  ✓ ${source.name}: без змін (${now})`);
      } else {
        console.log(`  ✗ ${source.name}: змінилась (в індексі ${stored ?? "—"}, у мережі ${now})`);
        problems += 1;
      }
    }
  }

  console.log(
    problems === 0
      ? "\n✓ усе гаразд"
      : `\n⚠ проблем: ${problems}. Перезбирання: npm run ingest -- --refresh`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});

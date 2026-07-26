/**
 * Пошук без LLM: npm run search -- "як створити інвойс"
 *
 * Потрібен, щоб дивитися саме на якість retrieval окремо від генерації —
 * коли відповідь погана, спершу треба зрозуміти, чи знайшлися потрібні чанки,
 * чи модель зіпсувала добрий контекст. Ключ API для цього не потрібен.
 */
import { search } from "./retrieve.ts";

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const question = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  if (!question) {
    console.error('Використання: npm run search -- "твоє питання" [--full]');
    process.exit(1);
  }

  const hits = await search(question, full ? 3 : 5);

  for (const [i, hit] of hits.entries()) {
    console.log(`${i + 1}. ${hit.score.toFixed(4)}  [${hit.chunk.spec}/${hit.chunk.kind}]  ${hit.chunk.title}`);
    if (full) {
      console.log(
        hit.chunk.text
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n"),
      );
      console.log();
    }
  }
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});

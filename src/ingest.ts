/**
 * Побудова індексу: специфікації → чанки → ембединги → data/index.json
 *
 * Запуск: npm run ingest [-- --refresh]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chunkSpec, type Chunk } from "./chunk.ts";
import { EMBEDDING_DIM, EMBEDDING_MODEL, embedPassages } from "./embed.ts";
import { INDEX_PATH, type SearchIndex } from "./index-store.ts";
import { loadAllSpecs } from "./specs.ts";

async function main() {
  const refresh = process.argv.includes("--refresh");

  console.log("→ завантажую специфікації monobank…");
  const specs = await loadAllSpecs(refresh);

  const chunks: Chunk[] = [];
  for (const { source, spec } of specs) {
    const produced = chunkSpec(source.name, spec);
    console.log(
      `  ${source.name}: ${Object.keys(spec.paths ?? {}).length} шляхів → ${produced.length} чанків`,
    );
    chunks.push(...produced);
  }

  if (chunks.length === 0) throw new Error("нема чого індексувати");

  console.log(`→ рахую ембединги локально (${EMBEDDING_MODEL})…`);
  const vectors = await embedPassages(
    chunks.map((chunk) => chunk.embedText),
    (done, total) => process.stdout.write(`\r  ${done}/${total}`),
  );
  process.stdout.write("\n");

  const index: SearchIndex = {
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    builtAt: new Date().toISOString(),
    chunks: chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] ?? [] })),
  };

  await mkdir(path.dirname(INDEX_PATH), { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(index), "utf8");

  console.log(`✓ ${index.chunks.length} чанків → ${path.relative(process.cwd(), INDEX_PATH)}`);
}

main().catch((error) => {
  console.error("✗ ingest впав:", error instanceof Error ? error.message : error);
  process.exit(1);
});

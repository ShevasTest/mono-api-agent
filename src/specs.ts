/**
 * Завантаження офіційних OpenAPI-специфікацій monobank.
 *
 * Обидві сторінки документації віддаються як Redoc-бандл, у якому повна
 * специфікація вшита в глобальну змінну `__redoc_state`. Дістаємо її звідти
 * і кешуємо на диск, щоб ingest не ходив у мережу щоразу.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

export interface SpecSource {
  /** Коротка назва, потрапляє в метадані чанка */
  name: string;
  url: string;
}

export const SPEC_SOURCES: SpecSource[] = [
  { name: "personal", url: "https://api.monobank.ua/docs/" },
  { name: "acquiring", url: "https://api.monobank.ua/docs/acquiring.html" },
];

const CACHE_DIR = path.resolve("data/specs");

/**
 * Вирізає перший збалансований JSON-об'єкт, що починається з позиції `from`.
 * Redoc не лишає зручних маркерів кінця, тому рахуємо дужки вручну.
 */
function extractBalancedJson(html: string, from: number): string {
  const start = html.indexOf("{", from);
  if (start === -1) throw new Error("не знайдено початок JSON-об'єкта");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }

  throw new Error("JSON-об'єкт не закрився — сторінка обрізана?");
}

function specFromRedocPage(html: string): OpenApiSpec {
  const marker = html.indexOf("__redoc_state");
  if (marker === -1) {
    throw new Error("на сторінці немає __redoc_state — Redoc змінив формат?");
  }

  const state = JSON.parse(extractBalancedJson(html, marker)) as {
    spec?: { data?: OpenApiSpec } & OpenApiSpec;
  };

  const spec = state.spec?.data ?? state.spec;
  if (!spec?.paths) throw new Error("у __redoc_state немає paths");
  return spec;
}

/** Повертає специфікацію з кешу, або тягне її з мережі та кешує. */
export async function loadSpec(source: SpecSource, refresh = false): Promise<OpenApiSpec> {
  const cachePath = path.join(CACHE_DIR, `${source.name}.json`);

  if (!refresh && existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, "utf8")) as OpenApiSpec;
  }

  const response = await fetch(source.url, {
    headers: { "user-agent": "mono-api-agent (docs ingest)" },
  });
  if (!response.ok) {
    throw new Error(`${source.url} → HTTP ${response.status}`);
  }

  const spec = specFromRedocPage(await response.text());

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(spec, null, 1), "utf8");

  return spec;
}

export async function loadAllSpecs(refresh = false) {
  const specs: Array<{ source: SpecSource; spec: OpenApiSpec }> = [];
  for (const source of SPEC_SOURCES) {
    specs.push({ source, spec: await loadSpec(source, refresh) });
  }
  return specs;
}

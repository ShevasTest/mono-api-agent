/**
 * Мінімальний .env-лоадер — щоб не тягти залежність заради двадцяти рядків.
 *
 * Файл має пріоритет над оточенням, і це свідомий відхід від звичної
 * поведінки dotenv. Причина не теоретична: у шелі користувача був
 * експортований застарілий GROQ_API_KEY тієї ж довжини, що й новий. Файл
 * .env мовчки програвав йому, кожен запит отримував 401, і виглядало це
 * як «провайдер не працює», а не як «ключ береться не звідти».
 *
 * Мовчазне затінення конфігурації — найгірший різновид помилки: вона
 * маскується під чужу. Тому файл перемагає, а про кожне перекриття
 * повідомляється.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Знімаємо лапки лише парні — щоб не зіпсувати значення з апострофом усередині.
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export interface LoadDotEnvOptions {
  /** false — лишити значення з оточення недоторканими (класична поведінка dotenv). */
  override?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface LoadDotEnvResult {
  /** Ключі, взяті з файлу. */
  applied: string[];
  /** Ключі, де файл перекрив інше значення з оточення. */
  overridden: string[];
}

export function applyDotEnv(
  values: Record<string, string>,
  { override = true, env = process.env }: LoadDotEnvOptions = {},
): LoadDotEnvResult {
  const applied: string[] = [];
  const overridden: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    const existing = env[key];

    if (existing === undefined) {
      env[key] = value;
      applied.push(key);
      continue;
    }

    if (existing === value) continue;
    if (!override) continue;

    env[key] = value;
    applied.push(key);
    overridden.push(key);
  }

  return { applied, overridden };
}

export async function loadDotEnv(
  file = ".env",
  options: LoadDotEnvOptions = {},
): Promise<LoadDotEnvResult> {
  if (!existsSync(file)) return { applied: [], overridden: [] };

  return applyDotEnv(parseDotEnv(await readFile(file, "utf8")), options);
}

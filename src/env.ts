/**
 * Мінімальний .env-лоадер — щоб не тягти залежність заради двадцяти рядків.
 *
 * Свідомо не перезаписує вже наявні змінні оточення: значення, передане
 * явно в командному рядку, має бути сильнішим за файл.
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

export async function loadDotEnv(file = ".env"): Promise<void> {
  if (!existsSync(file)) return;

  for (const [key, value] of Object.entries(parseDotEnv(await readFile(file, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

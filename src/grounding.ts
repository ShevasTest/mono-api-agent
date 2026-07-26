/**
 * Перевірка заземлення відповіді — без виклику моделі.
 *
 * Спершу цю роль виконував LLM-суддя: окремий виклик питав модель, чи
 * спирається відповідь на контекст. На практиці це виявилось найгіршим
 * вузлом у графі. Маленька безкоштовна модель систематично відповідала
 * `grounded: false` на цілком коректні відповіді, через що граф запускав
 * зайвий цикл пошуку. Один прохід коштував 60 секунд і два зайвих виклики.
 *
 * Механічна перевірка вирішує ту саму задачу краще: галюцинація в цьому
 * домені майже завжди виглядає як вигаданий шлях ендпоїнта або неіснуюче
 * поле, а це перевіряється точним пошуком по контексту — миттєво, безкоштовно
 * і без хибних спрацювань.
 */

/** Шляхи виду /api/merchant/..., /personal/..., /bank/... */
const PATH_PATTERN = /\/(?:api|personal|bank)\/[A-Za-z0-9_\-/{}]*[A-Za-z0-9_}]/g;

/**
 * Фрази, якими модель зізнається, що даних бракує. Інструкція в системному
 * промпті прямо просить про це сказати, тож така фраза — сигнал, а не шум.
 */
const ADMISSION_PATTERNS = [
  /у контекст[іi]\s+(?:не|нема|відсутн)/i,
  /в контекст[іi]\s+(?:не|нема|відсутн)/i,
  /(?:бракує|не\s+вистачає)\s+(?:даних|інформації)/i,
  /не\s+(?:вказано|описано|наведено|зазначено)\s+(?:у|в)\s+(?:специфікац|контекст|документац)/i,
  /немає\s+(?:інформації|даних)\s+(?:про|щодо)/i,
];

export interface GroundingReport {
  grounded: boolean;
  /** Шляхи, згадані у відповіді, яких нема в контексті. */
  invented: string[];
  /** Модель сама сказала, що даних бракує. */
  admitsGap: boolean;
  /** Запит для повторного пошуку, якщо є сенс шукати ще раз. */
  refinedQuery?: string;
}

/** Нормалізує шлях: прибирає хвостову косу і уніфікує плейсхолдери. */
function normalizePath(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "").toLowerCase();
}

export function extractPaths(text: string): string[] {
  const found = text.match(PATH_PATTERN) ?? [];
  return [...new Set(found)];
}

export function checkGrounding(answer: string, context: string, question: string): GroundingReport {
  const contextPaths = new Set(extractPaths(context).map(normalizePath));

  const invented = extractPaths(answer).filter((path) => {
    const normalized = normalizePath(path);
    if (contextPaths.has(normalized)) return false;
    // Шлях може бути згаданий у контексті як частина довшого рядка —
    // наприклад, без query-частини. Приймаємо і такий збіг.
    return ![...contextPaths].some(
      (known) => known.startsWith(normalized) || normalized.startsWith(known),
    );
  });

  const admitsGap = ADMISSION_PATTERNS.some((pattern) => pattern.test(answer));
  const grounded = invented.length === 0 && !admitsGap;

  if (grounded) return { grounded: true, invented: [], admitsGap: false };

  // Вигаданий шлях — найкращий можливий пошуковий запит: саме його
  // модель шукала в контексті й не знайшла.
  const refinedQuery = invented[0] ?? question;

  return { grounded: false, invented, admitsGap, refinedQuery };
}

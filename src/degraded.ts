/**
 * Відповідь без моделі.
 *
 * Сенс усієї конструкції — користувач ніколи не має побачити «відповіді
 * немає». Якщо не відповіла жодна модель із жодного провайдера, у нас усе
 * одно лишається найцінніше: знайдені фрагменти офіційної специфікації.
 * Тоді ми чесно кажемо, що модель недоступна, і віддаємо сам матеріал —
 * це гірше за згенеровану відповідь, але незрівнянно краще за помилку.
 */
/** Мінімум, потрібний для відповіді без моделі. */
export interface SourceExcerpt {
  title: string;
  text: string;
}

/** Дістає з чанка рядки, які найкорисніші людині без переказу моделі. */
function outline(text: string, maxLines: number): string[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const meaningful = lines.filter(
    (line) => !line.startsWith("# ") && !line.startsWith("Специфікація:"),
  );
  return meaningful.slice(0, maxLines);
}

export function degradedAnswer(
  question: string,
  hits: readonly SourceExcerpt[],
  liveData?: string,
): string {
  if (hits.length === 0 && !liveData) {
    return (
      "Жодна мовна модель зараз недоступна, і в специфікації не знайшлося " +
      `нічого релевантного до питання «${question}».\n` +
      "Спробуй переформулювати питання термінами API — назвою методу або поля."
    );
  }

  const parts: string[] = [
    "⚠️ Жодна мовна модель зараз недоступна, тому відповідь не згенерована.",
    "Нижче — те, що знайшлося в офіційній специфікації monobank за твоїм питанням.",
  ];

  if (liveData) parts.push("", liveData);

  for (const [i, hit] of hits.slice(0, 3).entries()) {
    parts.push("", `${i + 1}. ${hit.title}`, ...outline(hit.text, 14).map((l) => `   ${l}`));
  }

  return parts.join("\n");
}

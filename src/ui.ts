/**
 * Оформлення виводу в терміналі.
 *
 * Головне правило: колір несе сенс, а не прикрашає. Службові рядки
 * приглушені, щоб не сперечалися з відповіддю; акцент лише там, де він
 * щось означає — стан, назва методу, межа блоку коду.
 *
 * Кольори вимикаються самі, коли вивід не в термінал (конвеєр, файл,
 * тести) або коли виставлено NO_COLOR. Інакше escape-послідовності
 * потрапили б у текст і зіпсували б і grep, і збережений лог.
 */
export interface UiOptions {
  isTty: boolean;
  env: NodeJS.ProcessEnv;
}

export function colorEnabled({ isTty, env }: UiOptions): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return isTty;
}

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
} as const;

export type Style = keyof Omit<typeof CODES, "reset">;

export class Ui {
  private readonly on: boolean;

  constructor(options: Partial<UiOptions> = {}) {
    this.on = colorEnabled({
      isTty: options.isTty ?? Boolean(process.stdout.isTTY),
      env: options.env ?? process.env,
    });
  }

  paint(text: string, ...styles: Style[]): string {
    if (!this.on || styles.length === 0) return text;
    return `${styles.map((s) => CODES[s]).join("")}${text}${CODES.reset}`;
  }

  dim = (text: string) => this.paint(text, "dim");
  bold = (text: string) => this.paint(text, "bold");
  ok = (text: string) => this.paint(text, "green");
  warn = (text: string) => this.paint(text, "yellow");
  err = (text: string) => this.paint(text, "red");
  accent = (text: string) => this.paint(text, "cyan");

  /** Заголовок розділу: приглушена лінія, щоб відділяти, але не кричати. */
  section(title: string): string {
    return `\n${this.dim("──")} ${this.bold(title)}`;
  }

  /**
   * Легке оформлення markdown, який віддають моделі.
   *
   * Свідомо підтримується лише те, що вони реально використовують: огорожі
   * коду, `код у рядку` та **жирний**. Повноцінний рендерер тут був би
   * зайвим — треба всього лише, щоб приклад запиту було видно як приклад.
   */
  renderAnswer(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let inCode = false;

    for (const line of lines) {
      if (line.trimStart().startsWith("```")) {
        inCode = !inCode;
        continue;
      }

      if (inCode) {
        out.push(`${this.dim("│")} ${this.accent(line)}`);
        continue;
      }

      out.push(this.inline(line));
    }

    return out.join("\n");
  }

  private inline(line: string): string {
    return line
      .replace(/`([^`]+)`/g, (_, code: string) => this.accent(code))
      .replace(/\*\*([^*]+)\*\*/g, (_, strong: string) => this.bold(strong));
  }
}

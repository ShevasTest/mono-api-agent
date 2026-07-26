import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Ui, colorEnabled } from "../src/ui.ts";

const ESC = "\u001b";
const plain = new Ui({ isTty: false, env: {} as NodeJS.ProcessEnv });
const colored = new Ui({ isTty: true, env: {} as NodeJS.ProcessEnv });

describe("вмикання кольору", () => {
  it("у терміналі колір увімкнений", () => {
    assert.equal(colorEnabled({ isTty: true, env: {} as NodeJS.ProcessEnv }), true);
  });

  it("у конвеєрі вимкнений — інакше escape-коди потраплять у файл", () => {
    assert.equal(colorEnabled({ isTty: false, env: {} as NodeJS.ProcessEnv }), false);
  });

  it("NO_COLOR вимикає навіть у терміналі", () => {
    assert.equal(colorEnabled({ isTty: true, env: { NO_COLOR: "1" } as NodeJS.ProcessEnv }), false);
  });

  it("порожній NO_COLOR теж вимикає — так вимагає домовленість", () => {
    assert.equal(colorEnabled({ isTty: true, env: { NO_COLOR: "" } as NodeJS.ProcessEnv }), false);
  });

  it("FORCE_COLOR вмикає поза терміналом", () => {
    assert.equal(colorEnabled({ isTty: false, env: { FORCE_COLOR: "1" } as NodeJS.ProcessEnv }), true);
  });

  it("FORCE_COLOR=0 не вмикає", () => {
    assert.equal(colorEnabled({ isTty: false, env: { FORCE_COLOR: "0" } as NodeJS.ProcessEnv }), false);
  });

  it("NO_COLOR сильніший за FORCE_COLOR", () => {
    const env = { NO_COLOR: "1", FORCE_COLOR: "1" } as NodeJS.ProcessEnv;
    assert.equal(colorEnabled({ isTty: true, env }), false);
  });
});

describe("фарбування", () => {
  it("без кольору текст лишається недоторканим", () => {
    assert.equal(plain.bold("текст"), "текст");
    assert.equal(plain.dim("текст"), "текст");
    assert.equal(plain.accent("текст"), "текст");
  });

  it("з кольором додаються коди й скидання", () => {
    const painted = colored.bold("текст");
    assert.ok(painted.startsWith(ESC));
    assert.ok(painted.includes("текст"));
    assert.ok(painted.endsWith(`${ESC}[0m`));
  });

  it("кілька стилів накладаються", () => {
    const painted = colored.paint("текст", "bold", "cyan");
    assert.ok(painted.includes("[1m"));
    assert.ok(painted.includes("[36m"));
  });

  it("заголовок розділу містить назву", () => {
    assert.ok(plain.section("Джерела").includes("Джерела"));
  });
});

describe("оформлення відповіді", () => {
  it("без кольору вміст зберігається повністю", () => {
    const answer = "Текст.\n\n```bash\ncurl -X POST url\n```\n\nКінець.";
    const rendered = plain.renderAnswer(answer);

    assert.ok(rendered.includes("Текст."));
    assert.ok(rendered.includes("curl -X POST url"));
    assert.ok(rendered.includes("Кінець."));
  });

  it("рядки-огорожі не потрапляють у вивід", () => {
    const rendered = plain.renderAnswer("```bash\ncode\n```");
    assert.ok(!rendered.includes("```"));
  });

  it("блок коду отримує ліву межу", () => {
    const rendered = plain.renderAnswer("```\ncode\n```");
    assert.match(rendered, /│ code/);
  });

  it("огорожа без назви мови теж розпізнається", () => {
    assert.ok(!plain.renderAnswer("```\nx\n```").includes("```"));
  });

  it("код у рядку втрачає зворотні лапки", () => {
    assert.equal(plain.renderAnswer("поле `amount` тут"), "поле amount тут");
  });

  it("жирний втрачає зірочки", () => {
    assert.equal(plain.renderAnswer("це **важливо** тут"), "це важливо тут");
  });

  it("звичайний текст не змінюється", () => {
    assert.equal(plain.renderAnswer("просто рядок"), "просто рядок");
  });

  it("незакрита огорожа не з'їдає решту тексту мовчки", () => {
    // Модель могла обірватись посеред блоку — те, що встигло вийти,
    // все одно має бути видно.
    const rendered = plain.renderAnswer("Текст.\n```bash\ncurl url");
    assert.ok(rendered.includes("curl url"));
  });

  it("порожня відповідь не ламає рендер", () => {
    assert.equal(plain.renderAnswer(""), "");
  });
});

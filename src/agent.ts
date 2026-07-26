/**
 * Граф агента (LangGraph).
 *
 *            ┌─────────┐
 *   START ──▶│  route  │── питання про курс? ──▶ ┌───────────┐
 *            └─────────┘                          │ fetchLive │
 *                 │ ні                            └─────┬─────┘
 *                 ▼                                     │
 *            ┌──────────┐◀────────────────────────────── ┘
 *            │ retrieve │◀──── уточнений запит ──┐
 *            └────┬─────┘                        │
 *                 ▼                              │
 *            ┌──────────┐     ┌────────┐   контексту   │
 *            │ generate │────▶│ verify │── не вистачає ─┘
 *            └──────────┘     └───┬────┘
 *                                 │ достатньо
 *                                 ▼
 *                                END
 *
 * Цикл retrieve → generate → verify існує тому, що перший пошук часто
 * промахується на питаннях, сформульованих не термінами документації
 * ("як брати гроші з картки" замість "invoice create"). Verify має право
 * переформулювати запит і сходити в пошук ще раз — але не більше двох
 * разів, інакше на поганому питанні граф крутився б вічно.
 *
 * Жоден вузол не має права впасти: допоміжні використовують значення за
 * замовчуванням, а `generate` при повній відсутності моделей збирає
 * відповідь із самої специфікації.
 */
import { END, START, ReducedValue, StateGraph, StateSchema } from "@langchain/langgraph";
import * as z from "zod";

import { degradedAnswer } from "./degraded.ts";
import { checkGrounding } from "./grounding.ts";
import { instrument, metrics } from "./metrics.ts";
import { AllModelsFailedError, reason, reasonJson } from "./reason.ts";
import { formatContext, search, type Hit } from "./retrieve.ts";
import { getCurrencyRates } from "./tools.ts";

const MAX_ATTEMPTS = 2;

export const AgentState = new StateSchema({
  question: z.string(),
  searchQuery: z.string().default(""),
  context: z.string().default(""),
  sources: new ReducedValue(z.array(z.string()).default(() => []), {
    reducer: (_current: string[], update: string[]) => update,
  }),
  liveData: z.string().default(""),
  answer: z.string().default(""),
  verdict: z.string().default(""),
  /** true — відповідь зібрана без моделі. */
  degraded: z.boolean().default(false),
  attempts: new ReducedValue(z.number().default(0), {
    reducer: (current: number, update: number) => current + update,
  }),
  trace: new ReducedValue(z.array(z.string()).default(() => []), {
    reducer: (current: string[], update: string[]) => current.concat(update),
  }),
});

type State = typeof AgentState.State;

/** Останній результат пошуку — щоб `generate` міг деградувати до чанків. */
let lastHits: Hit[] = [];

const ANSWER_SYSTEM = `Ти — інженерний асистент по API monobank.

Правила:
- Відповідай ВИКЛЮЧНО на основі наданого контексту з офіційної специфікації.
- Якщо в контексті чогось нема — прямо скажи, чого саме бракує. Не вигадуй назв полів, ендпоїнтів чи заголовків.
- Називай точні шляхи, HTTP-методи та імена полів так, як вони в специфікації.
- Якщо доречно — покажи короткий приклад запиту (curl або fetch).
- Відповідай українською, стисло і по суті.`;

async function route(state: State) {
  const { value, via, degraded } = await reasonJson<{ needsLiveData: boolean }>(
    {
      system:
        'Ти класифікатор. Відповідай лише JSON виду {"needsLiveData": true|false}. ' +
        "true — якщо питання про ПОТОЧНИЙ курс валют. " +
        "false — якщо питання про те, як влаштоване API monobank, його ендпоїнти, поля, авторизацію.",
      user: state.question,
      maxTokens: 60,
    },
    { needsLiveData: false },
  );

  // Класифікатор недоступний — безпечніше піти в документацію: там
  // відповідь хоча б релевантна, тоді як зайвий похід у курси валют
  // видав би людині щось геть не по темі.
  const needsLiveData = degraded ? false : value.needsLiveData === true;

  return {
    searchQuery: state.question,
    verdict: needsLiveData ? "live" : "docs",
    trace: [
      `route: ${needsLiveData ? "потрібні живі дані" : "лише документація"}` +
        (degraded ? " (класифікатор недоступний, взято типове)" : ` [${via}]`),
    ],
  };
}

async function fetchLive(_state: State) {
  const liveData = await getCurrencyRates();
  return { liveData, trace: ["fetchLive: викликано /bank/currency"] };
}

async function retrieve(state: State) {
  // На повторному заході беремо ширше — перший промах часто означає, що
  // потрібний чанк був на межі топу.
  const topK = state.attempts === 0 ? 5 : 8;
  const hits = await search(state.searchQuery || state.question, topK);
  lastHits = hits;

  return {
    context: formatContext(hits),
    sources: hits.map((hit) => hit.chunk.title),
    attempts: 1,
    trace: [
      `retrieve (спроба ${state.attempts + 1}, k=${topK}): ${hits
        .map((hit) => `${hit.chunk.title} ${hit.score.toFixed(3)}`)
        .join(" | ")}`,
    ],
  };
}

async function generate(state: State) {
  const user = [
    state.liveData ? `Живі дані з API:\n${state.liveData}\n` : "",
    `Контекст зі специфікації:\n${state.context}`,
    `\nПитання: ${state.question}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { text, via } = await reason({ system: ANSWER_SYSTEM, user });
    return { answer: text, degraded: false, trace: [`generate: відповідь складено [${via}]`] };
  } catch (error) {
    if (!(error instanceof AllModelsFailedError)) throw error;

    return {
      answer: degradedAnswer(state.question, lastHits, state.liveData || undefined),
      degraded: true,
      verdict: "ok",
      trace: [
        `generate: жодна модель не відповіла (${error.attempts.length} спроб) → ` +
          "відповідь зібрано з документації",
      ],
    };
  }
}

async function verify(state: State) {
  // Деградовану відповідь перевіряти нічим і нема сенсу: вона за побудовою
  // складається лише з фрагментів специфікації.
  if (state.degraded) {
    return { verdict: "ok", trace: ["verify: пропущено (відповідь без моделі)"] };
  }

  const report = checkGrounding(state.answer, state.context, state.question);

  if (report.grounded) {
    return { verdict: "ok", trace: ["verify: усі згадані шляхи є в контексті"] };
  }

  const why = report.invented.length
    ? `шляхів нема в контексті: ${report.invented.join(", ")}`
    : "модель повідомила, що даних бракує";

  return {
    verdict: "insufficient",
    searchQuery: report.refinedQuery?.trim() || state.searchQuery,
    trace: [`verify: ${why} → новий запит "${report.refinedQuery ?? "той самий"}"`],
  };
}

/**
 * Куди йти після маршрутизації. Винесено з побудови графа, щоб рішення
 * можна було перевірити без запуску всього пайплайну.
 */
export function routeDecision(state: Pick<State, "verdict">): "fetchLive" | "retrieve" {
  return state.verdict === "live" ? "fetchLive" : "retrieve";
}

/** Чи має сенс ще один прохід пошуку. */
export function verifyDecision(
  state: Pick<State, "verdict" | "attempts">,
): "retrieve" | typeof END {
  return state.verdict === "insufficient" && state.attempts < MAX_ATTEMPTS ? "retrieve" : END;
}

export const graph = new StateGraph(AgentState)
  .addNode("route", instrument("route", route))
  .addNode("fetchLive", instrument("fetchLive", fetchLive))
  .addNode("retrieve", instrument("retrieve", retrieve))
  .addNode("generate", instrument("generate", generate))
  .addNode("verify", instrument("verify", verify))
  .addEdge(START, "route")
  .addConditionalEdges("route", routeDecision)
  .addEdge("fetchLive", "retrieve")
  .addEdge("retrieve", "generate")
  .addEdge("generate", "verify")
  .addConditionalEdges("verify", verifyDecision)
  .compile();

export interface AskResult {
  answer: string;
  sources: string[];
  trace: string[];
  attempts: number;
  degraded: boolean;
  metrics: string;
}

export async function ask(question: string): Promise<AskResult> {
  metrics.reset();
  lastHits = [];

  const final = (await graph.invoke({ question })) as State;

  return {
    answer: final.answer,
    sources: final.sources,
    trace: final.trace,
    attempts: final.attempts,
    degraded: final.degraded,
    metrics: metrics.report(),
  };
}

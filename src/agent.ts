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
 */
import { END, START, ReducedValue, StateGraph, StateSchema } from "@langchain/langgraph";
import * as z from "zod";

import { chat, chatJson } from "./llm.ts";
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
  attempts: new ReducedValue(z.number().default(0), {
    reducer: (current: number, update: number) => current + update,
  }),
  trace: new ReducedValue(z.array(z.string()).default(() => []), {
    reducer: (current: string[], update: string[]) => current.concat(update),
  }),
});

type State = typeof AgentState.State;

const ANSWER_SYSTEM = `Ти — інженерний асистент по API monobank.

Правила:
- Відповідай ВИКЛЮЧНО на основі наданого контексту з офіційної специфікації.
- Якщо в контексті чогось нема — прямо скажи, чого саме бракує. Не вигадуй назв полів, ендпоїнтів чи заголовків.
- Називай точні шляхи, HTTP-методи та імена полів так, як вони в специфікації.
- Якщо доречно — покажи короткий приклад запиту (curl або fetch).
- Відповідай українською, стисло і по суті.`;

/** Чи це питання про живі дані, чи про документацію. */
async function route(state: State) {
  const { needsLiveData } = await chatJson<{ needsLiveData: boolean }>(
    {
      system:
        "Ти класифікатор. Відповідай лише JSON виду {\"needsLiveData\": true|false}. " +
        "true — якщо питання про ПОТОЧНИЙ курс валют. " +
        "false — якщо питання про те, як влаштоване API monobank, його ендпоїнти, поля, авторизацію.",
      user: state.question,
      maxTokens: 50,
    },
    { needsLiveData: false },
  );

  return {
    searchQuery: state.question,
    trace: [`route: ${needsLiveData ? "потрібні живі дані" : "лише документація"}`],
    verdict: needsLiveData ? "live" : "docs",
  };
}

async function fetchLive(state: State) {
  const liveData = await getCurrencyRates();
  return { liveData, trace: ["fetchLive: викликано /bank/currency"] };
}

async function retrieve(state: State) {
  // На повторному заході беремо ширше — перший промах часто означає, що
  // потрібний чанк був на межі топу.
  const topK = state.attempts === 0 ? 5 : 8;
  const hits: Hit[] = await search(state.searchQuery || state.question, topK);

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
  const answer = await chat({
    system: ANSWER_SYSTEM,
    user: [
      state.liveData ? `Живі дані з API:\n${state.liveData}\n` : "",
      `Контекст зі специфікації:\n${state.context}`,
      `\nПитання: ${state.question}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return { answer, trace: ["generate: відповідь складено"] };
}

async function verify(state: State) {
  const result = await chatJson<{ grounded: boolean; refinedQuery?: string }>(
    {
      system:
        "Ти перевіряєш, чи відповідь повністю спирається на наданий контекст. " +
        'Поверни лише JSON: {"grounded": true|false, "refinedQuery": "..."}. ' +
        "grounded=false лише якщо у контексті бракує даних для відповіді. " +
        "refinedQuery — переформульоване пошукове питання термінами OpenAPI (шлях, метод, назва поля).",
      user: `Контекст:\n${state.context.slice(0, 6000)}\n\nВідповідь:\n${state.answer}`,
      maxTokens: 200,
    },
    { grounded: true },
  );

  if (result.grounded) {
    return { verdict: "ok", trace: ["verify: відповідь спирається на контекст"] };
  }

  return {
    verdict: "insufficient",
    searchQuery: result.refinedQuery?.trim() || state.searchQuery,
    trace: [`verify: контексту бракує → новий запит "${result.refinedQuery ?? "той самий"}"`],
  };
}

export const graph = new StateGraph(AgentState)
  .addNode("route", route)
  .addNode("fetchLive", fetchLive)
  .addNode("retrieve", retrieve)
  .addNode("generate", generate)
  .addNode("verify", verify)
  .addEdge(START, "route")
  .addConditionalEdges("route", (state: State) =>
    state.verdict === "live" ? "fetchLive" : "retrieve",
  )
  .addEdge("fetchLive", "retrieve")
  .addEdge("retrieve", "generate")
  .addEdge("generate", "verify")
  .addConditionalEdges("verify", (state: State) =>
    state.verdict === "insufficient" && state.attempts < MAX_ATTEMPTS ? "retrieve" : END,
  )
  .compile();

export interface AskResult {
  answer: string;
  sources: string[];
  trace: string[];
  attempts: number;
}

export async function ask(question: string): Promise<AskResult> {
  const final = (await graph.invoke({ question })) as State;

  return {
    answer: final.answer,
    sources: final.sources,
    trace: final.trace,
    attempts: final.attempts,
  };
}

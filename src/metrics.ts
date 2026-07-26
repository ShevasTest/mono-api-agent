/**
 * Спостережуваність: скільки коштував і скільки тривав кожен крок графа.
 *
 * Саме ці заміри показали, що LLM-суддя у вузлі verify з'їдав чверть часу
 * проходу — після чого його замінили на детерміновану перевірку.
 *
 * Два рішення, які тут неочевидні:
 *
 * 1. Кроки рахуються ПО ПОРЯДКУ, а не по іменах вузлів. Граф має цикл, тож
 *    `retrieve` і `generate` трапляються в одному проході двічі. Перша версія
 *    групувала по імені й показувала токени другого проходу в рядку першого.
 *
 * 2. Лічильники живуть у AsyncLocalStorage, а не в одному об'єкті на процес.
 *    Глобальний лічильник влаштовував доти, доки запит був один; два
 *    паралельні `ask()` перемішали б свої кроки й токени в спільну купу.
 *    ALS дає кожному проходу власний ізольований набір, не протягуючи
 *    лічильник параметром через усі вузли графа.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface LlmCall {
  step: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface StepTiming {
  step: number;
  node: string;
  durationMs: number;
}

class Collector {
  calls: LlmCall[] = [];
  steps: StepTiming[] = [];
  currentStep = -1;
  stepCounter = 0;

  reset() {
    this.calls = [];
    this.steps = [];
    this.currentStep = -1;
    this.stepCounter = 0;
  }
}

const storage = new AsyncLocalStorage<Collector>();

/**
 * Збірник за замовчуванням — для коду поза `runIsolated`: разових скриптів,
 * тестів окремих функцій, ручних викликів.
 */
const ambient = new Collector();

function current(): Collector {
  return storage.getStore() ?? ambient;
}

class Metrics {
  /** Виконує прохід із власним ізольованим набором лічильників. */
  runIsolated<T>(fn: () => Promise<T>): Promise<T> {
    return storage.run(new Collector(), fn);
  }

  reset() {
    current().reset();
  }

  beginStep(): number {
    const collector = current();
    collector.currentStep = collector.stepCounter;
    collector.stepCounter += 1;
    return collector.currentStep;
  }

  recordStep(step: number, node: string, durationMs: number) {
    current().steps.push({ step, node, durationMs });
  }

  recordCall(call: Omit<LlmCall, "step"> & { step?: number }) {
    const collector = current();
    collector.calls.push({ ...call, step: call.step ?? collector.currentStep });
  }

  get totalTokens(): number {
    return current().calls.reduce((sum, c) => sum + c.promptTokens + c.completionTokens, 0);
  }

  get llmMs(): number {
    return current().calls.reduce((sum, c) => sum + c.durationMs, 0);
  }

  get totalMs(): number {
    return current().steps.reduce((sum, s) => sum + s.durationMs, 0);
  }

  get callCount(): number {
    return current().calls.length;
  }

  report(): string {
    const { steps, calls } = current();
    if (steps.length === 0) return "(метрик нема)";

    const totalMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
    const totalTokens = calls.reduce((sum, c) => sum + c.promptTokens + c.completionTokens, 0);
    const llmMs = calls.reduce((sum, c) => sum + c.durationMs, 0);

    const lines = [
      `всього ${totalMs} мс · викликів моделі ${calls.length} · ` +
        `токенів ${totalTokens} (з них у моделі ${llmMs} мс)`,
      "",
    ];

    for (const step of steps) {
      const stepCalls = calls.filter((c) => c.step === step.step);
      const tokens = stepCalls.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0);
      const share = totalMs > 0 ? Math.round((step.durationMs / totalMs) * 100) : 0;

      lines.push(
        `  ${step.node.padEnd(10)} ${String(step.durationMs).padStart(6)} мс  ` +
          `${String(share).padStart(3)}%` +
          (stepCalls.length ? `  · ${stepCalls.length} виклик(и), ${tokens} токенів` : ""),
      );
    }

    return lines.join("\n");
  }
}

export const metrics = new Metrics();

/** Обгортка вузла: міряє час і прив'язує виклики моделі до конкретного кроку. */
export function instrument<TState, TResult>(
  node: string,
  fn: (state: TState) => Promise<TResult>,
): (state: TState) => Promise<TResult> {
  return async (state: TState) => {
    const step = metrics.beginStep();
    const started = Date.now();
    try {
      return await fn(state);
    } finally {
      metrics.recordStep(step, node, Date.now() - started);
    }
  };
}

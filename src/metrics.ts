/**
 * Спостережуваність: скільки коштував і скільки тривав кожен прохід графа.
 *
 * Без цього неможливо приймати рішення про cost/quality. Саме ці заміри
 * показали, що LLM-суддя у вузлі verify з'їдав чверть часу проходу — після
 * чого його замінили на детерміновану перевірку.
 *
 * Важлива деталь: вузли рахуються ПО КРОКАХ, а не по іменах. Граф має цикл,
 * тож `retrieve` і `generate` трапляються в одному проході двічі. Перша
 * версія групувала по імені й показувала токени другого проходу в рядку
 * першого — тобто подвоювала їх.
 */
export interface LlmCall {
  /** Номер кроку графа, до якого належить виклик. */
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

class Metrics {
  private calls: LlmCall[] = [];
  private steps: StepTiming[] = [];
  private currentStep = -1;
  private stepCounter = 0;

  reset() {
    this.calls = [];
    this.steps = [];
    this.currentStep = -1;
    this.stepCounter = 0;
  }

  /** Вузли графа виконуються послідовно, тож достатньо лічильника кроків. */
  beginStep(): number {
    this.currentStep = this.stepCounter;
    this.stepCounter += 1;
    return this.currentStep;
  }

  recordStep(step: number, node: string, durationMs: number) {
    this.steps.push({ step, node, durationMs });
  }

  recordCall(call: Omit<LlmCall, "step"> & { step?: number }) {
    this.calls.push({ ...call, step: call.step ?? this.currentStep });
  }

  get totalTokens(): number {
    return this.calls.reduce((sum, c) => sum + c.promptTokens + c.completionTokens, 0);
  }

  get llmMs(): number {
    return this.calls.reduce((sum, c) => sum + c.durationMs, 0);
  }

  get totalMs(): number {
    return this.steps.reduce((sum, s) => sum + s.durationMs, 0);
  }

  get callCount(): number {
    return this.calls.length;
  }

  report(): string {
    if (this.steps.length === 0) return "(метрик нема)";

    const lines = [
      `всього ${this.totalMs} мс · викликів моделі ${this.calls.length} · ` +
        `токенів ${this.totalTokens} (з них у моделі ${this.llmMs} мс)`,
      "",
    ];

    for (const step of this.steps) {
      const stepCalls = this.calls.filter((c) => c.step === step.step);
      const tokens = stepCalls.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0);
      const share = this.totalMs > 0 ? Math.round((step.durationMs / this.totalMs) * 100) : 0;

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

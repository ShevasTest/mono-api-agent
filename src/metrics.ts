/**
 * Спостережуваність: скільки коштував і скільки тривав кожен прохід графа.
 *
 * Без цього неможливо приймати рішення про cost/quality: коли додаєш вузол
 * self-check, він майже подвоює кількість викликів моделі, і треба бачити,
 * що саме ти купуєш за ці токени. Тому лічильники живуть окремо від логіки
 * і збираються по вузлах, а не сумарно.
 */
export interface LlmCall {
  /** Вузол графа, з якого пішов виклик. */
  node: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface NodeTiming {
  node: string;
  durationMs: number;
}

class Metrics {
  private calls: LlmCall[] = [];
  private timings: NodeTiming[] = [];
  private currentNode = "—";

  reset() {
    this.calls = [];
    this.timings = [];
    this.currentNode = "—";
  }

  /** Вузли виконуються послідовно, тож достатньо простого «поточного». */
  enterNode(node: string) {
    this.currentNode = node;
  }

  recordNode(node: string, durationMs: number) {
    this.timings.push({ node, durationMs });
  }

  recordCall(call: Omit<LlmCall, "node"> & { node?: string }) {
    this.calls.push({ ...call, node: call.node ?? this.currentNode });
  }

  get totalTokens(): number {
    return this.calls.reduce((sum, c) => sum + c.promptTokens + c.completionTokens, 0);
  }

  get llmMs(): number {
    return this.calls.reduce((sum, c) => sum + c.durationMs, 0);
  }

  get totalMs(): number {
    return this.timings.reduce((sum, t) => sum + t.durationMs, 0);
  }

  report(): string {
    if (this.timings.length === 0) return "(метрик нема)";

    const lines = [
      `всього ${this.totalMs} мс · викликів моделі ${this.calls.length} · токенів ${this.totalTokens} (з них у моделі ${this.llmMs} мс)`,
      "",
    ];

    for (const timing of this.timings) {
      const nodeCalls = this.calls.filter((c) => c.node === timing.node);
      const tokens = nodeCalls.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0);
      const share = this.totalMs > 0 ? Math.round((timing.durationMs / this.totalMs) * 100) : 0;

      lines.push(
        `  ${timing.node.padEnd(10)} ${String(timing.durationMs).padStart(6)} мс  ${String(share).padStart(3)}%` +
          (nodeCalls.length ? `  · ${nodeCalls.length} виклик(и), ${tokens} токенів` : ""),
      );
    }

    return lines.join("\n");
  }
}

export const metrics = new Metrics();

/** Обгортка вузла: міряє час і підказує лічильникам, хто зараз працює. */
export function instrument<TState, TResult>(
  node: string,
  fn: (state: TState) => Promise<TResult>,
): (state: TState) => Promise<TResult> {
  return async (state: TState) => {
    metrics.enterNode(node);
    const started = Date.now();
    try {
      return await fn(state);
    } finally {
      metrics.recordNode(node, Date.now() - started);
    }
  };
}

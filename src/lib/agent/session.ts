import type { Dataset } from "../analytics/schema";
import { prepare, type PreparedData } from "../analytics/core";
import type { Experiment } from "../analytics/experiments";
import { executeTool, type ToolContext } from "./tools";
import type { ToolStep } from "./report";

/** Records every tool execution so the investigation log reflects what actually ran. */
export class ToolSession {
  readonly steps: ToolStep[] = [];
  readonly activity: string[] = [];
  readonly ctx: ToolContext;

  constructor(dataset: Dataset, prepared?: PreparedData) {
    this.ctx = { dataset, data: prepared ?? prepare(dataset.events) };
  }

  run(tool: string, input: unknown): ToolStep {
    const t0 = performance.now();
    const outcome = executeTool(tool, input, this.ctx);
    const step: ToolStep = {
      id: `T${this.steps.length + 1}`,
      tool,
      input,
      status: outcome.ok ? "ok" : "error",
      ...(outcome.ok ? { output: outcome.result } : { error: outcome.error }),
      duration_ms: Math.round(performance.now() - t0),
    };
    this.steps.push(step);
    return step;
  }

  note(text: string) {
    this.activity.push(text);
  }

  experiments(): Experiment[] {
    return this.steps.filter((s) => s.tool === "generate_experiment" && s.status === "ok").map((s) => s.output as Experiment);
  }
}

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Dataset } from "../analytics/schema";
import { isoDay, type PreparedData } from "../analytics/core";
import { ToolSession } from "./session";
import { toolDefinitions } from "./tools";
import { SubmittedReportSchema, checkGrounding, type InvestigationResult, type SubmittedReport } from "./report";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_ITERATIONS = 10;
const MAX_TOOL_CALLS = 20;
const TOTAL_BUDGET_MS = 240_000;

export function liveAgentAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function systemPrompt(dataset: Dataset, data: PreparedData): string {
  return `You are GrowthPilot, a product-growth analyst for "StockSchool", a stock-market learning app. You investigate product analytics questions for product managers using ONLY the analytical tools provided.

Active dataset: "${dataset.meta.name}" (dataset_id: ${dataset.meta.id}, source: ${dataset.meta.source}, ${dataset.meta.rowCount} rows). Data spans ${isoDay(data.minTs)} to ${isoDay(data.maxTs)}; relative ranges such as last_7_days end on ${isoDay(data.maxTs)}.

How to work:
- Plan briefly, then call tools. Start with validate_event_data when data quality could affect the answer. Follow up on surprising results (e.g. localise a decline by segment and funnel step) before concluding. Call independent tools in parallel.
- Every number you state must come from a tool result in this conversation. Never estimate, extrapolate or invent figures. Quote rates as percentages with one decimal (0.4302 → 43.0%).
- Distinguish "supported" findings (statistically significant, adequate sample, directly shown by a tool) from "hypothesis" (plausible explanations the data cannot confirm, e.g. a release bug). Correlation is not causation; say so where relevant.
- Respect tool warnings: small samples, zero denominators, incomplete observation windows, and data-quality issues belong in limitations.
- When a supported finding suggests an intervention, call generate_experiment with numbers copied from tool results. Never promise an experiment will succeed.
- If the question cannot be answered from product event data (it needs data the dataset lacks, or is outside product analytics), do not run unnecessary tools; submit a report with answer_status "unsupported" or "insufficient_evidence" explaining why.
- Finish by calling submit_report exactly once. In evidence, reference tool calls by the ids shown in tool results (e.g. "T3"). Keep the summary to 2–4 sentences.
- Any write action outside these tools (sending messages, changing product settings, launching experiments) is not available; recommend it as a next step requiring human confirmation instead.`;
}

function submitReportTool() {
  const schema = z.toJSONSchema(SubmittedReportSchema, { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: "submit_report",
    description:
      "Submit the final structured investigation report. Call exactly once, after analysis. Evidence must reference successful tool call ids (T1, T2, …).",
    input_schema: { ...schema, type: "object" as const },
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.";
  if (e instanceof Anthropic.PermissionDeniedError) return "The API key does not have access to this model (403).";
  if (e instanceof Anthropic.NotFoundError) return "Model not found (404). Check ANTHROPIC_MODEL.";
  if (e instanceof Anthropic.RateLimitError) return "Claude API rate limit reached (429). Try again shortly.";
  if (e instanceof Anthropic.BadRequestError) return `Claude API rejected the request (400): ${e.message}`;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "The Claude API request timed out.";
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API (network error).";
  if (e instanceof Anthropic.APIError) return `Claude API error (${e.status ?? "unknown"}).`;
  return e instanceof Error ? e.message : "Unknown error";
}

export async function runLiveInvestigation(
  question: string,
  dataset: Dataset,
  prepared?: PreparedData,
): Promise<InvestigationResult> {
  const started = Date.now();
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const client = new Anthropic({ maxRetries: 2 });
  const s = new ToolSession(dataset, prepared);
  const tools = [...toolDefinitions(), submitReportTool()];
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: question }];
  let submitted: SubmittedReport | null = null;
  let fallbackText = "";
  let error: string | undefined;
  let limitation: string | null = null;

  try {
    for (let iter = 0; iter < MAX_ITERATIONS && !submitted; iter++) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
      if (remaining < 5_000) {
        limitation = "Investigation stopped at the time budget before a final report was submitted.";
        break;
      }
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          system: systemPrompt(dataset, s.ctx.data),
          tools,
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { timeout: remaining },
      );

      if (response.stop_reason === "refusal") {
        error = "Claude declined to continue this request.";
        break;
      }
      messages.push({ role: "assistant", content: response.content });

      for (const b of response.content) if (b.type === "text" && b.text.trim()) fallbackText = b.text.trim();
      const uses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason === "max_tokens" && uses.length === 0) {
        limitation = "The model response hit the output limit.";
        break;
      }
      if (uses.length === 0) break; // ended without submit_report

      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        if (u.name === "submit_report") {
          const parsed = SubmittedReportSchema.safeParse(u.input);
          if (parsed.success) {
            submitted = parsed.data;
            results.push({ type: "tool_result", tool_use_id: u.id, content: "Report received." });
          } else {
            results.push({
              type: "tool_result",
              tool_use_id: u.id,
              is_error: true,
              content: `Report failed validation: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
          }
          continue;
        }
        if (s.steps.length >= MAX_TOOL_CALLS) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Tool-call budget exhausted. Submit your report now." });
          continue;
        }
        const step = s.run(u.name, u.input);
        s.note(`Ran ${u.name} (${step.id})${step.status === "error" ? " — rejected: " + step.error : ""}.`);
        results.push({
          type: "tool_result",
          tool_use_id: u.id,
          is_error: step.status === "error",
          content: step.status === "ok" ? JSON.stringify({ tool_call_id: step.id, result: step.output }) : `${step.id} failed: ${step.error}`,
        });
      }
      if (submitted) break;
      messages.push({ role: "user", content: results });
    }
    if (!submitted && !error && !limitation) limitation = "The agent stopped without submitting a structured report (step limit or unstructured answer).";
  } catch (e) {
    error = errorMessage(e);
  }

  const report: SubmittedReport = submitted ?? {
    summary: fallbackText.slice(0, 2000) || (error ? "The investigation could not be completed." : "No report was produced."),
    answer_status: "partially_answered",
    findings: [],
    limitations: [],
    next_steps: [],
  };
  if (limitation) report.limitations = [...report.limitations, limitation];
  if (error) report.limitations = [...report.limitations, `Error: ${error}`];

  return {
    id: `inv-${started.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    question,
    mode: "live",
    model,
    dataset: { id: dataset.meta.id, name: dataset.meta.name, source: dataset.meta.source, rows: dataset.meta.rowCount },
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    steps: s.steps,
    activity: s.activity,
    report: { ...report, experiments: s.experiments(), grounding: checkGrounding(report, s.steps) },
    ...(error ? { error } : {}),
  };
}

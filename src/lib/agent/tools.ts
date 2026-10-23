import { z } from "zod";
import { EVENT_NAMES, DEFAULT_FUNNEL, type Dataset } from "../analytics/schema";
import {
  DateRangeSchema,
  SEGMENT_DIMENSIONS,
  SegmentFilterSchema,
  resolveRange,
  type PreparedData,
} from "../analytics/core";
import { TREND_METRICS, SEGMENT_METRICS, getMetricTrend, compareSegments } from "../analytics/metrics";
import { analyzeFunnel, compareFunnelPeriods } from "../analytics/funnel";
import { calculateRetention } from "../analytics/retention";
import { validateEvents } from "../analytics/quality";
import { FindingSchema, generateExperiment } from "../analytics/experiments";

/* ------------------------------------------------------------------ */
/* Input schemas (Zod is the source of truth; JSON Schema is derived)  */
/* ------------------------------------------------------------------ */

export const ToolInputSchemas = {
  get_metric_trend: z
    .object({
      metric: z.enum(TREND_METRICS),
      date_range: DateRangeSchema,
      segments: SegmentFilterSchema.optional(),
    })
    .strict(),
  analyze_funnel: z
    .object({
      event_sequence: z
        .array(z.enum(EVENT_NAMES))
        .min(2)
        .max(6)
        .refine((a) => new Set(a).size === a.length, "event_sequence must not repeat events")
        .optional(),
      date_range: DateRangeSchema,
      segments: SegmentFilterSchema.optional(),
      compare_previous_period: z.boolean().optional(),
      conversion_window_days: z.number().int().min(1).max(90).optional(),
    })
    .strict(),
  calculate_cohort_retention: z
    .object({
      cohort_definition: z
        .object({
          date_range: DateRangeSchema,
          granularity: z.enum(["day", "week"]).optional(),
          days: z.array(z.number().int().min(1).max(90)).min(1).max(5).optional(),
          window_days: z.number().int().min(1).max(14).optional(),
          segments: SegmentFilterSchema.optional(),
          split_by: z.enum(SEGMENT_DIMENSIONS).optional(),
        })
        .strict(),
    })
    .strict(),
  compare_segments: z
    .object({
      metric: z.enum(SEGMENT_METRICS),
      segment_dimension: z.enum(SEGMENT_DIMENSIONS),
      date_range: DateRangeSchema.optional(),
      base_filter: SegmentFilterSchema.optional(),
    })
    .strict(),
  validate_event_data: z.object({ dataset_id: z.string().min(1).max(80) }).strict(),
  generate_experiment: z.object({ finding: FindingSchema, target_metric: z.string().min(2).max(120) }).strict(),
} as const;

export type ToolName = keyof typeof ToolInputSchemas;
export const ANALYTICAL_TOOLS = Object.keys(ToolInputSchemas) as ToolName[];

const DESCRIPTIONS: Record<ToolName, string> = {
  get_metric_trend:
    "Daily time series of a product metric for a date range, plus totals for the range and the equal-length previous period, absolute/relative change, and (for rate metrics) a two-proportion significance test. Relative presets are anchored to the last day in the dataset.",
  analyze_funnel:
    `Ordered user-level funnel: unique users per step, step-to-step and overall conversion, drop-off counts and percentages, biggest drop. Default sequence: ${DEFAULT_FUNNEL.join(" → ")}. Users enter on their first step-1 event in the range; later steps must occur in order within the conversion window. Set compare_previous_period to get per-step changes vs the prior period with p-values. To isolate checkout, start the sequence at course_viewed.`,
  calculate_cohort_retention:
    "Registration-cohort retention on day N (activity in the 24h window starting N days after registration). Users whose day-N window is not fully observed are excluded from the denominator (reported as 'incomplete'), not counted as churned. Optional split_by compares segments (e.g. onboarding_status) with significance tests.",
  compare_segments:
    "Compare a rate metric across values of one segment dimension with numerators, denominators, 95% Wilson CIs, difference vs the rest, p-values, and small-sample flags (n < 30 excluded from best/worst).",
  validate_event_data:
    "Run data-quality checks on the active dataset: duplicates, missing values, timestamp problems, users without registration, ordering issues. dataset_id must equal the active dataset id.",
  generate_experiment:
    "Turn ONE supported finding into a structured A/B experiment proposal (hypothesis, change, segment, primary + guardrail metrics, sample size, risks, support/reject conditions). All numeric inputs (baseline_rate, comparison_rate, sample_size) MUST be copied from earlier tool results.",
};

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: { type: "object"; [k: string]: unknown };
}

export function toolDefinitions(): ToolDefinition[] {
  return ANALYTICAL_TOOLS.map((name) => {
    const schema = z.toJSONSchema(ToolInputSchemas[name], { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: DESCRIPTIONS[name], input_schema: { ...schema, type: "object" } };
  });
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  dataset: Dataset;
  data: PreparedData;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

const MAX_RESULT_CHARS = 40_000;

/** Replace non-finite numbers with null and cap payload size. */
function sanitize(value: unknown): unknown {
  const json = JSON.stringify(value, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v));
  if (json.length > MAX_RESULT_CHARS) throw new Error(`tool result too large (${json.length} chars)`);
  return JSON.parse(json);
}

/**
 * Execute one approved analytical tool. Unknown tool names and invalid inputs
 * are rejected; nothing outside this switch can run. All work is
 * deterministic TypeScript over the active dataset (no SQL, no eval).
 */
export function executeTool(name: string, rawInput: unknown, ctx: ToolContext): ToolOutcome {
  if (!(ANALYTICAL_TOOLS as string[]).includes(name)) return { ok: false, error: `Unknown or unapproved tool "${name}".` };
  const tool = name as ToolName;
  const parsed = ToolInputSchemas[tool].safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
    };
  }
  try {
    const { data, dataset } = ctx;
    let result: unknown;
    switch (tool) {
      case "get_metric_trend": {
        const i = ToolInputSchemas.get_metric_trend.parse(parsed.data);
        result = getMetricTrend(data, i.metric, resolveRange(i.date_range, data), i.segments);
        break;
      }
      case "analyze_funnel": {
        const i = ToolInputSchemas.analyze_funnel.parse(parsed.data);
        const opts = {
          steps: i.event_sequence,
          range: resolveRange(i.date_range, data),
          segments: i.segments,
          conversionWindowDays: i.conversion_window_days,
        };
        result = i.compare_previous_period ? compareFunnelPeriods(data, opts) : analyzeFunnel(data, opts);
        break;
      }
      case "calculate_cohort_retention": {
        const c = ToolInputSchemas.calculate_cohort_retention.parse(parsed.data).cohort_definition;
        const r = calculateRetention(data, {
          range: resolveRange(c.date_range, data),
          granularity: c.granularity,
          days: c.days,
          windowDays: c.window_days,
          segments: c.segments,
          splitBy: c.split_by,
        });
        // keep payload compact for the model: most recent 12 cohorts
        result = { ...r, cohorts: r.cohorts.slice(-12), cohorts_total: r.cohorts.length };
        break;
      }
      case "compare_segments": {
        const i = ToolInputSchemas.compare_segments.parse(parsed.data);
        result = compareSegments(data, i.metric, i.segment_dimension, resolveRange(i.date_range, data), i.base_filter);
        break;
      }
      case "validate_event_data": {
        const i = ToolInputSchemas.validate_event_data.parse(parsed.data);
        if (i.dataset_id !== dataset.meta.id)
          return { ok: false, error: `dataset_id "${i.dataset_id}" is not the active dataset ("${dataset.meta.id}"). Datasets are never combined.` };
        const report = validateEvents(dataset.meta.id, dataset.events, { now: data.maxTs + 86_400_000 });
        result = { ...report, dataset_name: dataset.meta.name, source: dataset.meta.source };
        break;
      }
      case "generate_experiment": {
        const i = ToolInputSchemas.generate_experiment.parse(parsed.data);
        result = generateExperiment(i.finding, i.target_metric);
        break;
      }
    }
    return { ok: true, result: sanitize(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Tool execution failed." };
  }
}

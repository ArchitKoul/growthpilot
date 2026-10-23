# Architecture

GrowthPilot is a single Next.js (App Router) application. The analytics engine is plain, deterministic TypeScript shared by the browser (dashboards) and the server (agent tools). A single Claude agent orchestrates those analytics through validated tools.

```
Browser (client components)                          Server (route handlers)
───────────────────────────                          ───────────────────────
DataProvider ── active dataset ──┐                   POST /api/investigate
  │ synthetic (generated locally) │  question +        │ Zod-validate body (≤12 MB, ≤60k events)
  │ uploaded CSV (tab memory)     │  dataset ref  ───▶ │ resolveDataset(): synthetic regenerated server-side,
  ▼                               │                    │                   uploads validated per event
Dashboards (Overview, Funnel,     │                    ├─ ANTHROPIC_API_KEY set → runLiveInvestigation (Claude)
Retention, Segments, Data)        │                    └─ otherwise           → runDemoInvestigation (rule-based)
  └─ call src/lib/analytics/* ────┘                          │
     directly (same code as tools)                           ▼
                                                       ToolSession ── executeTool(name, input)
Investigation workspace ◀── InvestigationResult ──       │  allow-list of 6 tools + Zod input schemas
  report · evidence check · tool log                     ▼
Experiments / Briefs (from saved results)            src/lib/analytics/*  (pure functions)
History: localStorage (+ Supabase if configured)    GET /api/status (capabilities only, never secrets)
```

## Modules

| Path | Responsibility |
|---|---|
| `src/lib/analytics/schema.ts` | Event schema (Zod), enums, funnel definition, qualifying activity |
| `src/lib/analytics/core.ts` | `prepare()` (sort, de-duplicate, per-user index), date ranges, segment filters |
| `src/lib/analytics/funnel.ts` | Ordered funnel + period comparison |
| `src/lib/analytics/retention.ts` | Cohort retention with observation-window eligibility |
| `src/lib/analytics/metrics.ts` | Metric trends and segment comparison |
| `src/lib/analytics/stats.ts` | Wilson CI, two-proportion z-test, sample size |
| `src/lib/analytics/quality.ts` | Data-quality checks |
| `src/lib/analytics/csv.ts` | CSV parser, column mapping, row validation, export |
| `src/lib/analytics/experiments.ts` | Finding → structured experiment (deterministic) |
| `src/lib/analytics/brief.ts` | Experiment → Markdown product brief |
| `src/lib/analytics/synthetic.ts` | Seeded synthetic dataset generator |
| `src/lib/agent/tools.ts` | Tool allow-list, Zod input schemas → JSON Schema, executor, output sanitising |
| `src/lib/agent/claude.ts` | Bounded Claude tool-use loop (server-only) |
| `src/lib/agent/demo.ts` | Deterministic demo planner using the same tools |
| `src/lib/agent/report.ts` | Report schema and the grounding (evidence) checker |
| `src/lib/server/*` | Dataset resolution, optional Supabase persistence (server-only) |

## Agent design

- **One agent.** A single Claude model with six analytical tools and one `submit_report` output tool. No multi-agent setup, because nothing in the workload needs one.
- **Tools** (`src/lib/agent/tools.ts`): `get_metric_trend`, `analyze_funnel`, `calculate_cohort_retention`, `compare_segments`, `validate_event_data`, `generate_experiment`. Their JSON Schemas are generated from Zod (`z.toJSONSchema`). Every input is re-validated with Zod before it runs. Unknown tool names are rejected, and so is a `validate_event_data` call naming a dataset other than the active one.
- **Loop** (`src/lib/agent/claude.ts`): manual loop on the official SDK (`client.beta.messages.create`). It is capped at 10 model turns, 20 tool calls and a 240 s total budget, with SDK retries (2) and a per-request timeout. Parallel tool calls are executed and their results returned in a single user message. `max_tokens`, `refusal` and API errors (typed SDK error classes) are handled and turned into safe messages. Tool errors go back to the model as `is_error` results, so it can correct itself.
- **Model config:** `claude-opus-5-5` (override with `ANTHROPIC_MODEL`), adaptive thinking, `effort: "medium"`, and server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
- **No arbitrary execution.** There is no SQL, no `eval`, and no code-execution tool. The model can only choose among the allow-listed functions and their validated parameters. All numbers come from deterministic code.
- **Structured output.** The model finishes by calling `submit_report`. That input is Zod-validated, and failures go back to the model for a retry. Experiments in the report are always the actual outputs of `generate_experiment`, never model-written.
- **Evidence check** (`checkGrounding`). Every number in the report text must match a value in a successful tool output, either directly, as a percentage, or as a difference between two rates in the same output (tolerance: half of the last displayed digit). Every evidence reference must point at a real successful call, and every "supported" finding must cite one. Small integers (≤ 31) and dates are exempt. The UI shows the result next to each report.
- **Transparency without chain-of-thought.** The log shows the real tool calls (inputs, outputs, timing) plus short activity notes. Raw model reasoning is not displayed.
- **No external writes.** The agent has no tools that send messages, change product settings or launch experiments. Recommendations are phrased as next steps that need human confirmation. Any future write tool must be gated behind explicit user confirmation in the UI.

## Funnel rules

1. Identity is `user_id`. Exact duplicates (same `user_id`, `event_name`, `timestamp`) are removed before any calculation.
2. A user enters on their **first** step-1 event inside the date range.
3. Each later step counts only if it occurs **at or after** the timestamp at which the previous step was reached, and within the conversion window (default 30 days) of entry. Out-of-order events do not count. Later steps may fall after the range end.
4. A user is counted at most once per step.
5. Step conversion = users(step) / users(previous step). Drop-off = users(previous) − users(step). Any rate with a zero denominator is `null` (shown as "—"), never 0 or NaN.
6. Entrants whose conversion window extends past the last observed event are counted as *immature* and flagged.
7. A course-category filter selects users by the category of their **first viewed course**, which biases pre-view steps upward. The UI and the tool warn about this.

## Retention rules

1. Cohort = users whose `registration` falls in the date range. Users without a registration event are excluded and counted separately.
2. Day N = the 24-hour window `[reg + N·24h, reg + (N+1)·24h)` (window length is configurable through the tool).
3. Qualifying activity: `app_open`, `lesson_completed`, `course_viewed`, `payment_initiated`, `purchase_completed`. Registration and onboarding are excluded.
4. **Eligibility:** a user counts toward Day N only if the whole window ends on or before the end of the last observed day. Users without a complete window are reported as `incomplete`/"pending" and excluded from the denominator. They are never counted as churned.
5. Cohorts are grouped by ISO week (Monday start) or by day, in UTC.

## Metric definitions

- **Purchase conversion:** users who viewed a course in the period and completed a purchase at or after their first in-period view, divided by users who viewed a course in the period.
- **Onboarding rate:** registrants in the period who completed onboarding (as observed), divided by registrants in the period.
- **Active users:** unique users with at least one qualifying activity event in the period.
- **Course views / purchases:** event counts after de-duplication.
- **Comparisons:** each period is compared with the previous period of equal length. Rates use a pooled two-proportion z-test (α = 0.05). If the previous period starts before the dataset, the tool warns and the dashboard suppresses the delta.
- **Segments:** 95% Wilson intervals. Segments with n < 30 are flagged and excluded from best/worst. Each segment is tested against all other segments combined.

## Relative dates

Relative ranges (`last_7_days` and similar) are anchored to the **last day in the dataset**, not to the wall clock, so results are reproducible. All dates are UTC.

## Security & reliability

- API keys are read only in server modules (`import "server-only"`). Nothing uses a `NEXT_PUBLIC_` prefix. `/api/status` reports capabilities only.
- Request bodies are capped at 12 MB. Uploaded datasets are capped at 60k events and validated event by event. CSV uploads are limited to `.csv` and 5 MB, and timestamps must be ISO dates or Unix epochs (ambiguous formats are rejected).
- Uploaded data stays in the browser tab. It is sent to the server only with an investigation request and is never stored. Supabase persistence (optional) stores investigation results only, with RLS enabled and service-role access.
- Server logs never include keys or event data. The only log line is the Supabase error code.
- Datasets are never merged. Each analysis names exactly one dataset id, and the report header shows it.

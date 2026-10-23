# Project plan

## Goal

Build a runnable AI Product Growth Agent with one primary workflow:

> A PM asks a question → the agent selects and calls validated analytical tools → deterministic code computes real results → the agent interprets the evidence → the report recommends experiments.

The demo product is StockSchool, a fictional stock-market learning app (see `DATASET.md`).

## Phases & status

### Phase 1: foundations ✅
- [x] Next.js 16 App Router + TypeScript + Tailwind v4 scaffold
- [x] Event schema (Zod) and canonical funnel
- [x] Seeded synthetic dataset with planted signals and quality issues
- [x] Deterministic analytics: funnel, retention, trends, segments, statistics, data quality
- [x] Unit tests with hand-computed expected values

### Phase 2: analytics UI ✅
- [x] Overview dashboard (KPIs, trends, funnel, cohorts, recent investigations)
- [x] Filters: date range (presets and custom), platform, acquisition channel, course category
- [x] Funnel page (sequence presets, conversion window, period comparison, rules)
- [x] Retention page (cohort heatmap, D1/D7/D30, split by segment, eligibility rules)
- [x] Segments page (metric × dimension, CIs, significance, small-sample flags)
- [x] Data page: CSV upload, column mapping, preview, row validation, quality report, dataset switching

### Phase 3: agent ✅
- [x] Six validated tools plus a `submit_report` tool
- [x] Bounded Claude tool-use loop with timeouts, retries, error mapping and refusal handling
- [x] Demo mode: a deterministic planner calling the same tools, clearly labelled
- [x] Investigation workspace with report, evidence links, evidence check and real tool log
- [x] Grounding checker for numeric claims and evidence references

### Phase 4: outputs, evaluation, deployment ✅
- [x] Structured experiment generator (sample size, guardrails, support/reject conditions)
- [x] Product brief generator with copy and Markdown export
- [x] 12 agent evaluation scenarios plus 4 guardrail tests, with results written by the test run
- [x] Mocked Claude-loop tests (no network)
- [x] Optional Supabase persistence (`supabase/schema.sql`)
- [x] Documentation and Vercel deployment notes

## Decisions

| Decision | Reason |
|---|---|
| Analytics in TypeScript, not SQL | Deterministic, unit-testable, and runs identically in the browser and on the server. No arbitrary SQL is possible. |
| Client computes dashboards | Instant filtering with no server round-trips. The data is small (≈120k events). |
| Synthetic data regenerated server-side | Investigations of the demo dataset send only an id, not 120k rows. |
| Uploaded data never persisted | Simplest privacy story. Persistence covers results only. |
| Manual tool loop (not the SDK tool runner) | Needs hard caps, a custom output tool, a log of each step and grounding, and must avoid an extra beta dependency. |
| Demo planner instead of mocked LLM responses | Demo mode really runs the analysis, so it is honest and still useful without a key. |
| Single agent | The task is one investigation thread. Multiple agents would add cost without a demonstrated benefit. |

## Future work

- Live-agent evaluation run with an API key (`evals/` can be extended to call `runLiveInvestigation`). It is not run here because it needs credentials and incurs cost.
- Streaming tool-step updates to the UI (server-sent events) instead of a single response.
- Postgres-backed event storage for datasets larger than browser memory, using the same tool interface.
- Authentication and per-user dataset ownership before multi-tenant use.
- Write actions (e.g. creating an experiment in a flagging tool), gated behind explicit user confirmation.

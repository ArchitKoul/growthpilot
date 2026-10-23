# GrowthPilot

**An AI product-growth agent that investigates product analytics, finds conversion and retention problems, and recommends evidence-backed experiments.**

Ask *"Why did purchase conversion decline over the last seven days?"* GrowthPilot picks analytical tools, runs deterministic calculations on your event data, localises the problem (for example *Android payment completion fell from 74.5% to 43.0%, p < 0.001*), separates supported findings from hypotheses, and proposes an A/B test with sample size, guardrails and support/reject criteria. Every number in the report is checked automatically against the tool outputs.

The example product is **StockSchool**, a fictional stock-market learning app with a documented synthetic dataset (see [docs/DATASET.md](docs/DATASET.md)).

## Features

| Area | What works |
|---|---|
| Overview | KPIs (registrations, active users, course views, purchases, conversion, revenue, D7/D30 retention) vs the previous period, trend charts, funnel, cohort heatmap, recent investigations. Filters: date range (presets and custom), platform, channel, course category. |
| Investigation workspace | Natural-language questions; Claude tool-use agent (live) or a deterministic planner (demo); structured report with supported findings vs hypotheses, limitations, an evidence check, and a log of the real tool calls with their inputs and outputs. |
| Funnel | Registration → Onboarding → Course view → Payment initiated → Purchase. Unique users, step and overall conversion, drop-offs, conversion window, significance-tested comparison with the previous period. |
| Retention | D1/D7/D30 cohort retention. Users with incomplete observation windows are excluded, not counted as churned. Split by onboarding, platform, channel or category. |
| Segments | Any rate metric × platform / channel / category / onboarding, with denominators, 95% CIs, tests vs rest, and small-sample flags. |
| Experiments | Problem, evidence, hypothesis, change, segment, primary and guardrail metrics, sample size and duration, risks, support/reject conditions, causal caveat. |
| Product briefs | Generated from an experiment; copy or download as Markdown. |
| Data | Synthetic dataset (with CSV download), CSV upload with column mapping, preview, row-level schema validation, duplicate/missing/timestamp checks, quality report, explicit active dataset. |

## Quick start

Requires Node.js ≥ 20.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. The app runs in **demo mode** with no credentials.

### Enable live AI investigations (optional)

```bash
cp .env.example .env.local
```

Set `ANTHROPIC_API_KEY` in `.env.local` and restart. The workspace then shows "Claude (live)" and investigations use `claude-opus-5-5` (override with `ANTHROPIC_MODEL`). Live runs are billed to your Anthropic account. The demo planner remains selectable.

### Optional persistence

Run [supabase/schema.sql](supabase/schema.sql) in your Supabase project and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Investigation results (not raw events) are then saved server-side. Without them, history lives in browser `localStorage`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | No | Enables live Claude investigations. Without it, demo mode is used. |
| `ANTHROPIC_MODEL` | No | Model override (default `claude-opus-5-5`). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | No | Persist investigation results. |

All are read server-side only; none is exposed to the browser.

## Demo vs live

| | Demo mode | Live mode |
|---|---|---|
| Needs a key | No | `ANTHROPIC_API_KEY` |
| Who chooses tools | Rule-based planner (keyword intent → fixed plan with data-driven follow-ups) | Claude, based on the question and tool results |
| Calculations | Same deterministic tools | Same deterministic tools |
| Report text | Templated from tool outputs | Written by Claude, validated by schema, evidence-checked |
| Labelling | "Demo mode · rule-based planner (no LLM)" | "Live AI · model name" |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (analytics + mocked agent loop) |
| `npm run eval` | Agent evaluation scenarios; writes [docs/EVAL_RESULTS.md](docs/EVAL_RESULTS.md) and `evals/results.json` |
| `npm run test:all` | All tests and evals |
| `npm run check` | typecheck + lint + all tests + build |

## Testing & evaluation

- **Analytics accuracy** (`src/lib/analytics/__tests__/analytics.test.ts`, 23 scenarios): hand-built fixtures with known answers. Covers funnel counts and order, duplicates, date ranges, zero denominators, small samples, immature windows, retention eligibility, onboarding split, ISO-week cohorts, purchase-conversion semantics, period comparison, segment CIs and tests, CSV parsing and mapping, quality checks, statistics reference values, experiment structure, and malformed input.
- **Agent loop** (`src/lib/agent/__tests__/claude.test.ts`, 8 tests): a scripted fake Claude client exercises tool execution, parallel results in one message, rejection of unapproved tools and malformed inputs, report validation and retry, the iteration cap, API errors, refusals, and the grounding checker catching fabricated numbers.
- **Agent evaluation** (`evals/agent.eval.test.ts`, 12 scenarios + 4 guardrail tests): planted-signal recovery, retention, funnel, segments, experiment requests, unsupported questions, missing data (NPS), data quality, a conflicting premise (a "decline" that isn't there), small samples, segment-scoped questions, and zero denominators. Scores tool selection, uncertainty handling, experiment structure, and unsupported-claim rate. Results are written by the run itself to [docs/EVAL_RESULTS.md](docs/EVAL_RESULTS.md).

The live Claude agent has not been evaluated against these scenarios (no key was used). The evaluation harness runs the demo planner.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, agent loop, funnel and retention rules, metric definitions and security model, and [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for phases, decisions and future work.

## Deploying to Vercel

1. Push the repository to GitHub and import it in Vercel (framework preset: Next.js; no build settings needed).
2. Optionally add `ANTHROPIC_API_KEY` (and Supabase variables) under *Settings → Environment Variables*.
3. Deploy. `/api/investigate` declares `maxDuration = 300`; live investigations can take 20–90 s, so use a plan whose function duration limit allows this.

## Limitations

- Uploaded datasets live in browser memory only (lost on reload) and are capped at 60k events and a 5 MB CSV.
- Live investigations return when finished; tool steps are not streamed in real time.
- No authentication: this is a single-user demo. Add auth before hosting real company data.
- Findings are observational. Experiments are proposals, not guarantees.

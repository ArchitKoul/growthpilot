/**
 * Demo-mode investigator. A transparent, rule-based planner that selects and
 * runs the SAME validated analytical tools the Claude agent uses, then writes
 * a templated report from the actual tool outputs. No LLM is involved; it is
 * labelled as such in the UI.
 */
import type { Dataset } from "../analytics/schema";
import type { PreparedData, SegmentDimension, SegmentFilter, DateRange } from "../analytics/core";
import type { FunnelComparison, FunnelResult } from "../analytics/funnel";
import type { RetentionResult } from "../analytics/retention";
import type { SegmentComparison, TrendResult } from "../analytics/metrics";
import type { QualityReport } from "../analytics/quality";
import type { Finding } from "../analytics/experiments";
import { ToolSession } from "./session";
import { checkGrounding, type InvestigationResult, type SubmittedReport, type ToolStep } from "./report";

export type Intent = "conversion" | "funnel" | "retention" | "segments" | "data_quality" | "unsupported" | "unavailable_data";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);
const fmtP = (p: number | null | undefined) => (p === null || p === undefined ? "n/a" : p < 0.001 ? "p < 0.001" : `p = ${p}`);
const pp = (x: number) => `${(Math.abs(x) * 100).toFixed(1)} pp`;

const UNSUPPORTED = /\b(stock price|share price|buy|sell|invest in|predict the market|forecast the market|weather|password|delete|drop table|execute|run code|email|personal data|who is user)\b/i;
const UNAVAILABLE = /\b(nps|net promoter|satisfaction|csat|rating|app store|reviews?|ad spend|cac|cost per|ltv|lifetime value|survey|push notification|marketing spend|competitor)\b/i;

export function classifyQuestion(q: string): Intent {
  const s = q.toLowerCase();
  if (UNSUPPORTED.test(s) && !/\bconversion|retention|funnel\b/.test(s)) return "unsupported";
  if (UNAVAILABLE.test(s)) return "unavailable_data";
  if (/retention|retain|churn|day ?(1|7|30)|d(1|7|30)\b|come back|return/.test(s)) return "retention";
  if (/declin|decreas|fell|falling|dropped/.test(s) && /conversion|purchase|checkout|payment|revenue|sales/.test(s)) return "conversion";
  if (/conversion|purchase|checkout|payment|revenue|sales/.test(s) && !/drop-?off|funnel|biggest|segment|convert best/.test(s)) return "conversion";
  if (/funnel|drop-?off|step|onboarding/.test(s)) return "funnel";
  if (/segment|platform|channel|category|android|ios|web|organic|paid|referral|which users|convert best/.test(s)) return "segments";
  if (/quality|duplicate|missing|valid/.test(s)) return "data_quality";
  if (/experiment|improve|increase|grow/.test(s)) return "conversion";
  return "unsupported";
}

export function parseRange(q: string, fallback: DateRange): DateRange {
  const m = q.toLowerCase().match(/last\s+(7|seven|14|fourteen|two weeks|30|thirty|month|90|ninety|quarter)/);
  if (!m) return fallback;
  const v = m[1];
  if (["7", "seven"].includes(v)) return { preset: "last_7_days" };
  if (["14", "fourteen", "two weeks"].includes(v)) return { preset: "last_14_days" };
  if (["30", "thirty", "month"].includes(v)) return { preset: "last_30_days" };
  return { preset: "last_90_days" };
}

function parseFilter(q: string): SegmentFilter | undefined {
  const s = q.toLowerCase();
  const platform = (["android", "ios", "web"] as const).filter((p) => new RegExp(`\\b${p}\\b`).test(s));
  return platform.length === 1 ? { platform: [...platform] } : undefined;
}

interface Draft {
  status: SubmittedReport["answer_status"];
  summary: string[];
  findings: SubmittedReport["findings"];
  limitations: string[];
  next: string[];
}

const ev = (step: ToolStep, detail: string) => ({ tool_call_id: step.id, detail });

function addQuality(s: ToolSession, d: Draft) {
  const st = s.run("validate_event_data", { dataset_id: s.ctx.dataset.meta.id });
  s.note(`Validated the active dataset "${s.ctx.dataset.meta.name}" before analysis.`);
  if (st.status !== "ok") return;
  const q = st.output as QualityReport;
  for (const c of q.checks.filter((c) => c.severity !== "info"))
    d.limitations.push(`Data quality (${st.id}): ${c.detail}`);
}

function significantDrops(c: FunnelComparison) {
  return c.step_changes.filter((x) => x.significant && (x.absolute_change ?? 0) < 0).sort((a, b) => (a.absolute_change ?? 0) - (b.absolute_change ?? 0));
}

function conversionPlan(s: ToolSession, q: string, d: Draft) {
  const range = parseRange(q, { preset: "last_7_days" });
  const filter = parseFilter(q);
  addQuality(s, d);

  const tStep = s.run("get_metric_trend", { metric: "purchase_conversion", date_range: range, ...(filter ? { segments: filter } : {}) });
  s.note("Measured purchase conversion for the period and the previous equal-length period.");
  const fStep = s.run("analyze_funnel", { date_range: range, compare_previous_period: true, ...(filter ? { segments: filter } : {}) });
  const cStep = s.run("analyze_funnel", {
    event_sequence: ["course_viewed", "payment_initiated", "purchase_completed"],
    date_range: range,
    compare_previous_period: true,
    ...(filter ? { segments: filter } : {}),
  });
  s.note("Inspected the full funnel and the checkout sub-funnel against the previous period.");

  const trend = tStep.output as TrendResult | undefined;
  if (trend) {
    const declined = (trend.absolute_change ?? 0) < 0;
    d.findings.push({
      title: declined ? "Purchase conversion declined" : "Purchase conversion did not decline",
      statement: `Purchase conversion was ${pct(trend.current.value)} (${trend.current.numerator}/${trend.current.denominator}) in ${trend.range} vs ${pct(trend.previous.value)} (${trend.previous.numerator}/${trend.previous.denominator}) in the previous period${trend.p_value !== null ? `, ${fmtP(trend.p_value)}` : ""}.`,
      type: trend.significant && declined ? "supported" : "hypothesis",
      confidence: trend.significant ? "high" : "low",
      evidence: [ev(tStep, `absolute change ${trend.absolute_change}, relative change ${trend.relative_change}`)],
    });
    d.summary.push(
      trend.significant && declined
        ? `Purchase conversion fell from ${pct(trend.previous.value)} to ${pct(trend.current.value)} and the drop is statistically significant (${fmtP(trend.p_value)}).`
        : `The change in purchase conversion (${pct(trend.previous.value)} → ${pct(trend.current.value)}) is not statistically significant${trend.p_value !== null ? ` (${fmtP(trend.p_value)})` : ""}, so a real decline is not established.`,
    );
    if (!trend.significant) d.status = "insufficient_evidence";
  }

  const checkout = cStep.output as FunnelComparison | undefined;
  const full = fStep.output as FunnelComparison | undefined;
  if (full?.current.immature_entrants)
    d.limitations.push(`${fStep.id}: ${full.current.warnings.find((w) => w.includes("conversion window")) ?? "Some entrants have immature conversion windows."} Registration-based steps in recent periods are therefore not directly comparable.`);
  const drop = checkout ? significantDrops(checkout)[0] : undefined;
  if (checkout && drop) {
    const fromStep = checkout.current.steps[checkout.current.steps.findIndex((x) => x.step === drop.step) - 1].step;
    d.findings.push({
      title: `Largest significant checkout decline: ${fromStep} → ${drop.step}`,
      statement: `${fromStep} → ${drop.step} conversion fell from ${pct(drop.previous_rate)} to ${pct(drop.current_rate)} (${pp(drop.absolute_change!)}, ${fmtP(drop.p_value)}).`,
      type: "supported",
      confidence: "high",
      evidence: [ev(cStep, `${drop.step}: ${drop.previous_rate} → ${drop.current_rate}`)],
    });
  }

  // Localise to segments
  const segSteps: { dim: SegmentDimension; step: ToolStep }[] = [];
  for (const dim of ["platform", "acquisition_channel"] as const) {
    if (filter && dim === "platform") continue;
    segSteps.push({ dim, step: s.run("compare_segments", { metric: "purchase_conversion", segment_dimension: dim, date_range: range, ...(filter ? { base_filter: filter } : {}) }) });
  }
  s.note("Compared purchase conversion across platforms and acquisition channels.");
  const candidates = segSteps
    .flatMap(({ dim, step }) =>
      ((step.output as SegmentComparison | undefined)?.rows ?? [])
        .filter((r) => r.significant_vs_rest && (r.diff_vs_rest ?? 0) < 0)
        .map((r) => ({ dim, step, row: r })),
    )
    .sort((a, b) => (a.row.diff_vs_rest ?? 0) - (b.row.diff_vs_rest ?? 0));

  let finding: Finding | null = null;
  const worst = candidates[0];
  if (worst) {
    const segFilter = { [worst.dim]: [worst.row.segment] } as SegmentFilter;
    const sfStep = s.run("analyze_funnel", {
      event_sequence: ["course_viewed", "payment_initiated", "purchase_completed"],
      date_range: range,
      segments: { ...filter, ...segFilter },
      compare_previous_period: true,
    });
    s.note(`Drilled into the checkout funnel for ${worst.dim} = ${worst.row.segment}.`);
    d.findings.push({
      title: `${worst.row.segment} under-performs on purchase conversion`,
      statement: `${worst.dim} = ${worst.row.segment} converted at ${pct(worst.row.rate)} (${worst.row.numerator}/${worst.row.denominator}), ${pp(worst.row.diff_vs_rest!)} below the other segments (${fmtP(worst.row.p_value_vs_rest)}).`,
      type: "supported",
      confidence: worst.row.denominator >= 100 ? "high" : "medium",
      evidence: [ev(worst.step, `rate ${worst.row.rate}, n = ${worst.row.denominator}`)],
    });
    const segCmp = sfStep.output as FunnelComparison | undefined;
    const segDrop = segCmp ? significantDrops(segCmp)[0] : undefined;
    if (segCmp && segDrop) {
      const idx = segCmp.current.steps.findIndex((x) => x.step === segDrop.step);
      const prevStepName = segCmp.current.steps[idx - 1].step;
      d.findings.push({
        title: `${worst.row.segment}: ${prevStepName} → ${segDrop.step} collapsed`,
        statement: `For ${worst.row.segment}, ${prevStepName} → ${segDrop.step} conversion fell from ${pct(segDrop.previous_rate)} to ${pct(segDrop.current_rate)} (${fmtP(segDrop.p_value)}), on ${segCmp.current.steps[idx - 1].users} users reaching ${prevStepName}.`,
        type: "supported",
        confidence: segCmp.current.steps[idx - 1].users >= 100 ? "high" : "medium",
        evidence: [ev(sfStep, `${segDrop.step}: ${segDrop.previous_rate} → ${segDrop.current_rate}`)],
      });
      d.findings.push({
        title: `Possible ${worst.row.segment}-specific defect in ${segDrop.step}`,
        statement: `A sharp, segment-specific fall at a single checkout step is consistent with a release, SDK or payment-provider issue on ${worst.row.segment}. This is a hypothesis: event data cannot show the cause.`,
        type: "hypothesis",
        confidence: "medium",
        evidence: [ev(sfStep, "decline concentrated in one step for one segment")],
      });
      d.summary.push(
        `The decline is concentrated in ${worst.row.segment}: ${prevStepName} → ${segDrop.step} fell from ${pct(segDrop.previous_rate)} to ${pct(segDrop.current_rate)}.`,
      );
      finding = {
        title: `${worst.row.segment} ${prevStepName} → ${segDrop.step} decline`,
        statement: `${worst.row.segment} ${prevStepName} → ${segDrop.step} conversion fell significantly versus the previous period.`,
        metric: "step_conversion",
        segment: { dimension: worst.dim, value: worst.row.segment },
        funnel_step: { from: prevStepName, to: segDrop.step },
        baseline_rate: segDrop.current_rate ?? 0,
        comparison_rate: segDrop.previous_rate ?? undefined,
        sample_size: segCmp.current.steps[idx - 1].users,
        analysed_days: daysOf(range, s.ctx.data),
        evidence: [`${sfStep.id}: ${prevStepName} → ${segDrop.step} ${pct(segDrop.previous_rate)} → ${pct(segDrop.current_rate)}`],
      };
    } else {
      d.summary.push(`${worst.row.segment} converts significantly worse than other segments.`);
    }
  } else {
    d.summary.push("No platform or channel segment differs significantly from the rest, so the change cannot be localised to a segment.");
  }

  if (!finding && checkout && drop) {
    const idx = checkout.current.steps.findIndex((x) => x.step === drop.step);
    finding = {
      title: `Checkout decline at ${drop.step}`,
      statement: `Conversion into ${drop.step} fell significantly versus the previous period.`,
      metric: "step_conversion",
      funnel_step: { from: checkout.current.steps[idx - 1].step, to: drop.step },
      baseline_rate: drop.current_rate ?? 0,
      comparison_rate: drop.previous_rate ?? undefined,
      sample_size: checkout.current.steps[idx - 1].users,
      analysed_days: daysOf(range, s.ctx.data),
      evidence: [`${cStep.id}: ${drop.step} ${pct(drop.previous_rate)} → ${pct(drop.current_rate)}`],
    };
  }
  if (finding) runExperiment(s, finding, finding.funnel_step ? `${finding.funnel_step.from} → ${finding.funnel_step.to} conversion` : "purchase_conversion");
  else d.next.push("Collect more data or widen the date range before designing an experiment; no finding is strong enough yet.");
  d.next.push("Check release logs and payment-provider dashboards for the affected dates before testing product changes.");
}

function daysOf(range: DateRange, data: PreparedData) {
  if ("preset" in range) return range.preset === "all" ? Math.max(1, Math.round((data.maxTs - data.minTs) / 86_400_000)) : Number(range.preset.split("_")[1]);
  return Math.max(1, Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1);
}

function runExperiment(s: ToolSession, finding: Finding, target: string) {
  const st = s.run("generate_experiment", { finding, target_metric: target });
  if (st.status === "ok") s.note("Generated a structured experiment proposal from the strongest supported finding.");
}

function funnelPlan(s: ToolSession, q: string, d: Draft) {
  const range = parseRange(q, { preset: "last_90_days" });
  const filter = parseFilter(q);
  addQuality(s, d);
  const fStep = s.run("analyze_funnel", { date_range: range, ...(filter ? { segments: filter } : {}) });
  s.note("Calculated the five-step purchase funnel.");
  const f = fStep.output as FunnelResult | undefined;
  if (!f || !f.biggest_drop) {
    d.status = "insufficient_evidence";
    d.summary.push("The funnel has no entrants for this range, so drop-off cannot be measured.");
    return;
  }
  const b = f.biggest_drop;
  const prev = f.steps.find((x) => x.step === b.from)!;
  const cur = f.steps.find((x) => x.step === b.to)!;
  d.summary.push(
    `Of ${f.entrants} registrants in ${f.range}, ${f.completers} purchased (${pct(f.overall_conversion)}). The biggest drop-off is ${b.from} → ${b.to}: ${b.drop_off_count} users (${pct(b.drop_off_pct)}) did not continue.`,
  );
  d.findings.push({
    title: `Biggest drop-off: ${b.from} → ${b.to}`,
    statement: `${pct(b.drop_off_pct)} of users who reached ${b.from} (${prev.users}) did not reach ${b.to} (${cur.users}).`,
    type: "supported",
    confidence: prev.users >= 100 ? "high" : "medium",
    evidence: [ev(fStep, `${b.from} ${prev.users} → ${b.to} ${cur.users}`)],
  });
  for (const w of f.warnings) d.limitations.push(`${fStep.id}: ${w}`);

  const sStep = s.run("compare_segments", { metric: "funnel_conversion", segment_dimension: "platform", date_range: range, ...(filter ? { base_filter: filter } : {}) });
  s.note("Compared overall funnel conversion by platform.");
  const sc = sStep.output as SegmentComparison | undefined;
  if (sc?.best && sc.worst && sc.best !== sc.worst) {
    const best = sc.rows.find((r) => r.segment === sc.best)!;
    const worst = sc.rows.find((r) => r.segment === sc.worst)!;
    const sig = worst.significant_vs_rest || best.significant_vs_rest;
    d.findings.push({
      title: `Funnel conversion varies by platform`,
      statement: `${best.segment} converts at ${pct(best.rate)} (n = ${best.denominator}) vs ${worst.segment} at ${pct(worst.rate)} (n = ${worst.denominator}).`,
      type: sig ? "supported" : "hypothesis",
      confidence: sig ? "medium" : "low",
      evidence: [ev(sStep, `spread ${sc.spread}`)],
    });
  }
  runExperiment(
    s,
    {
      title: `Drop-off at ${b.from} → ${b.to}`,
      statement: `${pct(b.drop_off_pct)} of users drop between ${b.from} and ${b.to}.`,
      metric: "step_conversion",
      funnel_step: { from: b.from, to: b.to },
      ...(filter ? { segment: { dimension: "platform", value: filter.platform![0] } } : {}),
      baseline_rate: cur.conversion_from_previous ?? 0,
      sample_size: prev.users,
      analysed_days: daysOf(range, s.ctx.data),
      evidence: [`${fStep.id}: ${b.from} ${prev.users} → ${b.to} ${cur.users}`],
    },
    `${b.from} → ${b.to} conversion`,
  );
}

function retentionPlan(s: ToolSession, q: string, d: Draft) {
  const range = parseRange(q, { preset: "all" });
  addQuality(s, d);
  const rStep = s.run("calculate_cohort_retention", { cohort_definition: { date_range: range, days: [1, 7, 30], split_by: "onboarding_status" } });
  s.note("Calculated D1/D7/D30 cohort retention, split by onboarding completion.");
  const r = rStep.output as RetentionResult | undefined;
  if (!r) return;
  const [d1, d7, d30] = r.overall;
  d.summary.push(
    `Across ${r.cohort_users} registered users, Day-1 retention is ${pct(d1.rate)}, Day-7 ${pct(d7.rate)} and Day-30 ${pct(d30.rate)} (Day-30 based on ${d30.eligible} users with a complete window; ${d30.incomplete} recent users excluded rather than counted as churned).`,
  );
  d.findings.push({
    title: "Day-30 retention level",
    statement: `Day-30 retention is ${pct(d30.rate)} (${d30.retained}/${d30.eligible}).`,
    type: "supported",
    confidence: d30.eligible >= 100 ? "high" : "medium",
    evidence: [ev(rStep, `D30 ${d30.retained}/${d30.eligible}`)],
  });
  if (d30.eligible === 0) d.status = "insufficient_evidence";

  const g = r.groups;
  const comp = g?.values.find((v) => v.value === "completed");
  const non = g?.values.find((v) => v.value === "not_completed");
  const t30 = g?.tests.find((t) => t.day === 30);
  let finding: Finding | null = null;
  if (comp && non) {
    const c30 = comp.cells.find((c) => c.day === 30)!;
    const n30 = non.cells.find((c) => c.day === 30)!;
    d.findings.push({
      title: "Onboarding completers retain far better",
      statement: `Day-30 retention is ${pct(c30.rate)} for onboarding completers (n = ${c30.eligible}) vs ${pct(n30.rate)} for non-completers (n = ${n30.eligible})${t30?.p_value !== null && t30 ? `, ${fmtP(t30.p_value)}` : ""}. This is a correlation: motivated users may both finish onboarding and return.`,
      type: t30?.significant ? "supported" : "hypothesis",
      confidence: t30?.significant ? "high" : "low",
      evidence: [ev(rStep, `completed ${c30.rate} vs not_completed ${n30.rate}`)],
    });
    d.summary.push(`Onboarding completers retain at ${pct(c30.rate)} on Day 30 vs ${pct(n30.rate)} for non-completers.`);
    if (t30?.significant && n30.rate !== null && c30.rate !== null)
      finding = {
        title: "Low Day-30 retention among onboarding non-completers",
        statement: "Users who skip onboarding have much lower Day-30 retention than completers.",
        metric: "d30_retention",
        segment: { dimension: "onboarding_status", value: "not_completed" },
        baseline_rate: n30.rate,
        comparison_rate: c30.rate,
        sample_size: n30.eligible,
        analysed_days: daysOf(range, s.ctx.data),
        evidence: [`${rStep.id}: D30 completed ${pct(c30.rate)} vs not completed ${pct(n30.rate)}`],
      };
  }

  const chStep = s.run("compare_segments", { metric: "d30_retention", segment_dimension: "acquisition_channel", date_range: range });
  s.note("Compared Day-30 retention across acquisition channels to check for confounding.");
  const ch = chStep.output as SegmentComparison | undefined;
  if (ch?.best && ch.worst) {
    const b = ch.rows.find((x) => x.segment === ch.best)!;
    const w = ch.rows.find((x) => x.segment === ch.worst)!;
    d.findings.push({
      title: "Retention differs by acquisition channel",
      statement: `Day-30 retention ranges from ${pct(w.rate)} (${w.segment}, n = ${w.denominator}) to ${pct(b.rate)} (${b.segment}, n = ${b.denominator}).`,
      type: w.significant_vs_rest || b.significant_vs_rest ? "supported" : "hypothesis",
      confidence: "medium",
      evidence: [ev(chStep, `spread ${ch.spread}`)],
    });
  }
  d.limitations.push("Onboarding status is self-selected; the onboarding gap is not proof that forcing onboarding would raise retention.");
  for (const w of r.warnings.filter((x) => x.includes("excluded"))) d.limitations.push(`${rStep.id}: ${w}`);
  if (finding) runExperiment(s, finding, "d30_retention");
}

function segmentsPlan(s: ToolSession, q: string, d: Draft) {
  const range = parseRange(q, { preset: "last_30_days" });
  addQuality(s, d);
  for (const dim of ["platform", "acquisition_channel", "course_category", "onboarding_status"] as const) {
    const st = s.run("compare_segments", { metric: "purchase_conversion", segment_dimension: dim, date_range: range });
    const c = st.output as SegmentComparison | undefined;
    if (!c?.best) continue;
    const b = c.rows.find((r) => r.segment === c.best)!;
    const w = c.rows.find((r) => r.segment === c.worst)!;
    d.findings.push({
      title: `By ${dim}: best ${b.segment}, worst ${w.segment}`,
      statement: `${b.segment} converts at ${pct(b.rate)} (${b.numerator}/${b.denominator}); ${w.segment} at ${pct(w.rate)} (${w.numerator}/${w.denominator}).`,
      type: b.significant_vs_rest || w.significant_vs_rest ? "supported" : "hypothesis",
      confidence: b.significant_vs_rest || w.significant_vs_rest ? "medium" : "low",
      evidence: [ev(st, `spread ${c.spread}`)],
    });
    for (const wn of c.warnings) d.limitations.push(`${st.id}: ${wn}`);
  }
  s.note("Compared purchase conversion across all four segment dimensions.");
  const sup = d.findings.filter((f) => f.type === "supported");
  d.summary.push(
    sup.length
      ? `${sup.length} of ${d.findings.length} segment dimensions show statistically significant differences in purchase conversion.`
      : "No segment dimension shows a statistically significant difference; observed gaps may be noise.",
  );
  if (!sup.length) d.status = "insufficient_evidence";
}

export function runDemoInvestigation(question: string, dataset: Dataset, prepared?: PreparedData): InvestigationResult {
  const started = Date.now();
  const s = new ToolSession(dataset, prepared);
  const intent = classifyQuestion(question);
  const d: Draft = { status: "answered", summary: [], findings: [], limitations: [], next: [] };
  s.note(`Interpreted the question as a ${intent.replace("_", " ")} question.`);

  switch (intent) {
    case "conversion":
      conversionPlan(s, question, d);
      break;
    case "funnel":
      funnelPlan(s, question, d);
      break;
    case "retention":
      retentionPlan(s, question, d);
      break;
    case "segments":
      segmentsPlan(s, question, d);
      break;
    case "data_quality": {
      addQuality(s, d);
      const q = s.steps[0].output as QualityReport | undefined;
      d.summary.push(q ? `Data quality status: ${q.status}. ${q.total_events} events from ${q.unique_users} users.` : "Validation failed.");
      break;
    }
    case "unavailable_data":
      addQuality(s, d);
      d.status = "insufficient_evidence";
      d.summary.push(
        "The active dataset only contains product events (user_id, event_name, timestamp, platform, acquisition_channel, course_category, session_id, revenue). It has no data on the requested topic, so this question cannot be answered from it.",
      );
      d.next.push("Import the relevant data source (e.g. survey, marketing spend or app-store data) as a separate dataset.");
      break;
    case "unsupported":
      d.status = "unsupported";
      d.summary.push(
        "GrowthPilot only answers product-analytics questions about the active event dataset (conversion, funnels, retention, segments, data quality, experiments). This question is outside that scope, so no tools were run and no claims are made.",
      );
      d.next.push('Try: "Why has purchase conversion declined over the last 7 days?" or "Why is Day 30 retention low?"');
      break;
  }
  if (d.findings.length === 0 && d.status === "answered" && intent !== "data_quality") d.status = "insufficient_evidence";
  d.limitations.push("Demo mode: findings are produced by a deterministic rule-based planner, not an LLM.");

  const submitted: SubmittedReport = {
    summary: d.summary.join(" "),
    answer_status: d.status,
    findings: d.findings,
    limitations: [...new Set(d.limitations)],
    next_steps: d.next,
  };
  return {
    id: `inv-${started.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    question,
    mode: "demo",
    model: null,
    dataset: { id: dataset.meta.id, name: dataset.meta.name, source: dataset.meta.source, rows: dataset.meta.rowCount },
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    steps: s.steps,
    activity: s.activity,
    report: { ...submitted, experiments: s.experiments(), grounding: checkGrounding(submitted, s.steps) },
  };
}

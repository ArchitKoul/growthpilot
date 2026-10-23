import { DAY_MS } from "./schema";
import {
  describeFilter,
  filterUsers,
  firstInWindow,
  isoDay,
  previousRange,
  ratio,
  round,
  segmentValue,
  type PreparedData,
  type ResolvedRange,
  type SegmentDimension,
  type SegmentFilter,
  type UserProfile,
} from "./core";
import { calculateRetention } from "./retention";
import { analyzeFunnel } from "./funnel";
import { MIN_SAMPLE, twoProportionTest, wilson } from "./stats";

export const TREND_METRICS = [
  "registrations",
  "active_users",
  "course_views",
  "purchases",
  "revenue",
  "purchase_conversion",
  "onboarding_rate",
] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];
export const RATE_METRICS: ReadonlySet<string> = new Set(["purchase_conversion", "onboarding_rate"]);

export const METRIC_DEFINITIONS: Record<string, string> = {
  registrations: "Users whose registration event falls in the period.",
  active_users: "Unique users with ≥1 qualifying activity event in the period.",
  course_views: "Count of course_viewed events (after de-duplication) in the period.",
  purchases: "Count of purchase_completed events in the period.",
  revenue: "Sum of revenue on purchase_completed events in the period.",
  purchase_conversion:
    "Users who viewed a course in the period and completed a purchase at/after their first view in that period ÷ users who viewed a course in the period.",
  onboarding_rate: "Users registered in the period who have completed onboarding (as observed) ÷ users registered in the period.",
  d1_retention: "Day-1 retention (see retention rules).",
  d7_retention: "Day-7 retention (see retention rules).",
  d30_retention: "Day-30 retention (see retention rules).",
  funnel_conversion: "Registration → purchase_completed overall funnel conversion within 30 days of registration.",
};

export interface MetricValue {
  value: number | null;
  numerator?: number;
  denominator?: number;
}

function countInWindow(sorted: number[] | undefined, lo: number, hi: number): number {
  if (!sorted) return 0;
  let n = 0;
  // arrays are short per user; linear scan from first hit is fine
  const first = firstInWindow(sorted, lo, hi);
  if (first === null) return 0;
  for (let i = sorted.indexOf(first); i < sorted.length && sorted[i] < hi; i++) n++;
  return n;
}

export function computeMetric(users: UserProfile[], metric: TrendMetric, data: PreparedData, lo: number, hi: number): MetricValue {
  switch (metric) {
    case "registrations": {
      let n = 0;
      for (const u of users) if (u.registeredAt !== null && u.registeredAt >= lo && u.registeredAt < hi) n++;
      return { value: n };
    }
    case "active_users": {
      let n = 0;
      for (const u of users) if (firstInWindow(u.activity, lo, hi) !== null) n++;
      return { value: n };
    }
    case "course_views": {
      let n = 0;
      for (const u of users) n += countInWindow(u.byEvent.course_viewed, lo, hi);
      return { value: n };
    }
    case "purchases": {
      let n = 0;
      for (const u of users) n += countInWindow(u.byEvent.purchase_completed, lo, hi);
      return { value: n };
    }
    case "revenue": {
      // revenue needs event-level data; restrict to the users passed in
      const ids = new Set(users.map((u) => u.id));
      let sum = 0;
      for (const e of data.events) {
        if (e.ts < lo) continue;
        if (e.ts >= hi) break;
        if (e.event_name === "purchase_completed" && e.revenue !== null && ids.has(e.user_id)) sum += e.revenue;
      }
      return { value: Math.round(sum * 100) / 100 };
    }
    case "purchase_conversion": {
      let den = 0;
      let num = 0;
      for (const u of users) {
        const v = firstInWindow(u.byEvent.course_viewed, lo, hi);
        if (v === null) continue;
        den++;
        if (firstInWindow(u.byEvent.purchase_completed, v, hi) !== null) num++;
      }
      return { value: round(ratio(num, den)), numerator: num, denominator: den };
    }
    case "onboarding_rate": {
      let den = 0;
      let num = 0;
      for (const u of users) {
        if (u.registeredAt === null || u.registeredAt < lo || u.registeredAt >= hi) continue;
        den++;
        if (u.onboardedAt !== null) num++;
      }
      return { value: round(ratio(num, den)), numerator: num, denominator: den };
    }
  }
}

export interface TrendResult {
  metric: TrendMetric;
  definition: string;
  range: string;
  previous_range: string;
  segment: string;
  series: { date: string; value: number | null; numerator?: number; denominator?: number }[];
  current: MetricValue;
  previous: MetricValue;
  absolute_change: number | null;
  relative_change: number | null;
  /** two-proportion test current vs previous (rate metrics only) */
  p_value: number | null;
  significant: boolean | null;
  warnings: string[];
}

/** Daily series for the range plus current-vs-previous-period comparison. */
export function getMetricTrend(
  data: PreparedData,
  metric: TrendMetric,
  range: ResolvedRange,
  segments?: SegmentFilter,
): TrendResult {
  const users = filterUsers(data, segments);
  const series: TrendResult["series"] = [];
  for (let d = range.start; d < range.end; d += DAY_MS) {
    series.push({ date: isoDay(d), ...computeMetric(users, metric, data, d, d + DAY_MS) });
  }
  const prev = previousRange(range);
  const current = computeMetric(users, metric, data, range.start, range.end);
  const previous = computeMetric(users, metric, data, prev.start, prev.end);
  const warnings: string[] = [];
  let p: number | null = null;
  let sig: boolean | null = null;
  if (RATE_METRICS.has(metric)) {
    if (!current.denominator || !previous.denominator) warnings.push("Zero denominator in one period; comparison undefined.");
    const t = twoProportionTest(current.numerator ?? 0, current.denominator ?? 0, previous.numerator ?? 0, previous.denominator ?? 0);
    if (t) {
      p = round(t.pValue);
      sig = t.significant;
    }
    if ((current.denominator ?? 0) < MIN_SAMPLE || (previous.denominator ?? 0) < MIN_SAMPLE)
      warnings.push(`Small sample (< ${MIN_SAMPLE}) in at least one period.`);
  }
  if (prev.start < Math.floor(data.minTs / DAY_MS) * DAY_MS) warnings.push("Previous period starts before the dataset begins; it is partially observed.");
  const abs = current.value !== null && previous.value !== null ? round(current.value - previous.value) : null;
  const rel = current.value !== null && previous.value ? round((current.value - previous.value) / previous.value) : null;
  return {
    metric,
    definition: METRIC_DEFINITIONS[metric],
    range: range.label,
    previous_range: prev.label,
    segment: describeFilter(segments),
    series,
    current,
    previous,
    absolute_change: abs,
    relative_change: rel,
    p_value: p,
    significant: sig,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Segment comparison                                                  */
/* ------------------------------------------------------------------ */

export const SEGMENT_METRICS = [
  "purchase_conversion",
  "onboarding_rate",
  "funnel_conversion",
  "d1_retention",
  "d7_retention",
  "d30_retention",
] as const;
export type SegmentMetric = (typeof SEGMENT_METRICS)[number];

export interface SegmentRow {
  segment: string;
  numerator: number;
  denominator: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  small_sample: boolean;
  /** vs all other segments combined */
  diff_vs_rest: number | null;
  p_value_vs_rest: number | null;
  significant_vs_rest: boolean;
}

export interface SegmentComparison {
  metric: SegmentMetric;
  dimension: SegmentDimension;
  definition: string;
  range: string;
  base_filter: string;
  rows: SegmentRow[];
  best: string | null;
  worst: string | null;
  spread: number | null;
  warnings: string[];
}

function rateFor(data: PreparedData, metric: SegmentMetric, users: UserProfile[], range: ResolvedRange) {
  const ids = new Set(users.map((u) => u.id));
  const filtered: PreparedData = { ...data, users: new Map([...data.users].filter(([id]) => ids.has(id))) };
  if (metric === "purchase_conversion" || metric === "onboarding_rate") {
    const m = computeMetric(users, metric, data, range.start, range.end);
    return { num: m.numerator ?? 0, den: m.denominator ?? 0 };
  }
  if (metric === "funnel_conversion") {
    const f = analyzeFunnel(filtered, { range, steps: ["registration", "purchase_completed"] });
    return { num: f.completers, den: f.entrants };
  }
  const day = metric === "d1_retention" ? 1 : metric === "d7_retention" ? 7 : 30;
  const r = calculateRetention(filtered, { range, days: [day] });
  return { num: r.overall[0].retained, den: r.overall[0].eligible };
}

export function compareSegments(
  data: PreparedData,
  metric: SegmentMetric,
  dimension: SegmentDimension,
  range: ResolvedRange,
  baseFilter?: SegmentFilter,
): SegmentComparison {
  const users = filterUsers(data, baseFilter);
  const groups = new Map<string, UserProfile[]>();
  for (const u of users) {
    const v = segmentValue(u, dimension);
    (groups.get(v) ?? groups.set(v, []).get(v)!).push(u);
  }
  const raw = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, us]) => ({ segment, ...rateFor(data, metric, us, range) }));
  const totNum = raw.reduce((s, r) => s + r.num, 0);
  const totDen = raw.reduce((s, r) => s + r.den, 0);

  const rows: SegmentRow[] = raw.map((r) => {
    const restNum = totNum - r.num;
    const restDen = totDen - r.den;
    const t = twoProportionTest(r.num, r.den, restNum, restDen);
    const rate = ratio(r.num, r.den);
    const rest = ratio(restNum, restDen);
    return {
      segment: r.segment,
      numerator: r.num,
      denominator: r.den,
      rate: round(rate),
      ci95: wilson(r.num, r.den),
      small_sample: r.den < MIN_SAMPLE,
      diff_vs_rest: rate !== null && rest !== null ? round(rate - rest) : null,
      p_value_vs_rest: t ? round(t.pValue) : null,
      significant_vs_rest: (t?.significant ?? false) && r.den >= MIN_SAMPLE,
    };
  });

  const valid = rows.filter((r) => r.rate !== null && !r.small_sample);
  const best = valid.length ? valid.reduce((a, b) => (b.rate! > a.rate! ? b : a)) : null;
  const worst = valid.length ? valid.reduce((a, b) => (b.rate! < a.rate! ? b : a)) : null;
  const warnings: string[] = [];
  for (const r of rows) {
    if (r.denominator === 0) warnings.push(`Segment "${r.segment}" has a zero denominator; rate is null.`);
    else if (r.small_sample) warnings.push(`Segment "${r.segment}" has only ${r.denominator} users (< ${MIN_SAMPLE}); excluded from best/worst.`);
  }
  if (dimension === "course_category")
    warnings.push("Course category is the category of each user's first viewed course; users who never viewed a course form 'no_course_viewed'.");
  if (dimension === "onboarding_status")
    warnings.push("Onboarding status is self-selected; differences are correlational, not causal.");

  return {
    metric,
    dimension,
    definition: METRIC_DEFINITIONS[metric],
    range: range.label,
    base_filter: describeFilter(baseFilter),
    rows,
    best: best?.segment ?? null,
    worst: worst?.segment ?? null,
    spread: best && worst ? round(best.rate! - worst.rate!) : null,
    warnings,
  };
}

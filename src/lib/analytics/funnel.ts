import {
  DAY_MS,
  type EventName,
  DEFAULT_FUNNEL,
} from "./schema";
import {
  describeFilter,
  filterUsers,
  firstInWindow,
  previousRange,
  ratio,
  round,
  type PreparedData,
  type ResolvedRange,
  type SegmentFilter,
} from "./core";
import { MIN_SAMPLE, twoProportionTest } from "./stats";

export interface FunnelStep {
  step: EventName;
  users: number;
  /** users(step) / users(previous step); null for the first step or zero denominator */
  conversion_from_previous: number | null;
  /** users(step) / users(first step) */
  conversion_from_start: number | null;
  /** users lost between previous step and this one */
  drop_off_count: number;
  /** drop_off_count / users(previous step) */
  drop_off_pct: number | null;
}

export interface FunnelResult {
  steps: FunnelStep[];
  entrants: number;
  completers: number;
  overall_conversion: number | null;
  biggest_drop: { from: EventName; to: EventName; drop_off_pct: number; drop_off_count: number } | null;
  /** entrants whose conversion window extends past the last observed event */
  immature_entrants: number;
  conversion_window_days: number;
  range: string;
  segment: string;
  warnings: string[];
}

export interface FunnelOptions {
  steps?: EventName[];
  range: ResolvedRange;
  segments?: SegmentFilter;
  conversionWindowDays?: number;
}

/**
 * Ordered, user-level funnel.
 *
 * Rules (see docs/ARCHITECTURE.md → Funnel rules):
 * 1. Identity is user_id. Exact duplicate events were removed in prepare().
 * 2. A user enters on their FIRST occurrence of step[0] inside the date range.
 * 3. Each later step counts only if it occurs at or after the timestamp at which
 *    the previous step was reached (out-of-order events do not count) and within
 *    `conversionWindowDays` of entry. Later steps may fall after the range end.
 * 4. A user is counted at most once per step.
 * 5. Rates with a zero denominator are null, never 0 or NaN.
 */
export function analyzeFunnel(data: PreparedData, opts: FunnelOptions): FunnelResult {
  const steps = opts.steps ?? DEFAULT_FUNNEL;
  const windowDays = opts.conversionWindowDays ?? 30;
  const counts = new Array(steps.length).fill(0) as number[];
  let immature = 0;

  for (const u of filterUsers(data, opts.segments)) {
    const entry = firstInWindow(u.byEvent[steps[0]], opts.range.start, opts.range.end);
    if (entry === null) continue;
    counts[0]++;
    const deadline = entry + windowDays * DAY_MS;
    if (deadline > data.maxTs) immature++;
    let prev = entry;
    for (let i = 1; i < steps.length; i++) {
      const t = firstInWindow(u.byEvent[steps[i]], prev, deadline + 1);
      if (t === null) break;
      counts[i]++;
      prev = t;
    }
  }

  const out: FunnelStep[] = steps.map((step, i) => {
    const prevUsers = i === 0 ? counts[0] : counts[i - 1];
    const drop = i === 0 ? 0 : prevUsers - counts[i];
    return {
      step,
      users: counts[i],
      conversion_from_previous: i === 0 ? null : round(ratio(counts[i], prevUsers)),
      conversion_from_start: round(ratio(counts[i], counts[0])),
      drop_off_count: drop,
      drop_off_pct: i === 0 ? null : round(ratio(drop, prevUsers)),
    };
  });

  let biggest: FunnelResult["biggest_drop"] = null;
  for (let i = 1; i < out.length; i++) {
    const d = out[i].drop_off_pct;
    if (d !== null && (biggest === null || d > biggest.drop_off_pct)) {
      biggest = { from: steps[i - 1], to: steps[i], drop_off_pct: d, drop_off_count: out[i].drop_off_count };
    }
  }

  const warnings: string[] = [];
  if (counts[0] === 0) warnings.push("No users entered the funnel in this range/segment; all rates are null.");
  else if (counts[0] < MIN_SAMPLE) warnings.push(`Small sample: only ${counts[0]} entrants (< ${MIN_SAMPLE}).`);
  if (immature > 0)
    warnings.push(
      `${immature} of ${counts[0]} entrants have not had a full ${windowDays}-day conversion window yet; later-step conversion may be understated.`,
    );
  if (opts.segments?.course_category?.length)
    warnings.push("Course-category filter keeps only users whose first viewed course is in the category, so pre-view steps are biased upward.");

  return {
    steps: out,
    entrants: counts[0],
    completers: counts[counts.length - 1],
    overall_conversion: round(ratio(counts[counts.length - 1], counts[0])),
    biggest_drop: biggest,
    immature_entrants: immature,
    conversion_window_days: windowDays,
    range: opts.range.label,
    segment: describeFilter(opts.segments),
    warnings,
  };
}

export interface FunnelComparison {
  current: FunnelResult;
  previous: FunnelResult;
  step_changes: {
    step: EventName;
    current_rate: number | null;
    previous_rate: number | null;
    absolute_change: number | null;
    p_value: number | null;
    significant: boolean;
  }[];
}

/** Current vs previous equal-length period, with a two-proportion test per step transition. */
export function compareFunnelPeriods(data: PreparedData, opts: FunnelOptions): FunnelComparison {
  const current = analyzeFunnel(data, opts);
  const previous = analyzeFunnel(data, { ...opts, range: previousRange(opts.range) });
  const step_changes = current.steps.slice(1).map((s, idx) => {
    const i = idx + 1;
    const p = previous.steps[i];
    const test = twoProportionTest(s.users, current.steps[i - 1].users, p.users, previous.steps[i - 1].users);
    return {
      step: s.step,
      current_rate: s.conversion_from_previous,
      previous_rate: p.conversion_from_previous,
      absolute_change:
        s.conversion_from_previous !== null && p.conversion_from_previous !== null
          ? round(s.conversion_from_previous - p.conversion_from_previous)
          : null,
      p_value: test ? round(test.pValue) : null,
      significant: test?.significant ?? false,
    };
  });
  return { current, previous, step_changes };
}

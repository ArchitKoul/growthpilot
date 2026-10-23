import { DAY_MS } from "./schema";
import {
  describeFilter,
  filterUsers,
  firstInWindow,
  isoDay,
  ratio,
  round,
  segmentValue,
  startOfDay,
  type PreparedData,
  type ResolvedRange,
  type SegmentDimension,
  type SegmentFilter,
  type UserProfile,
} from "./core";
import { MIN_SAMPLE, twoProportionTest, wilson } from "./stats";

export interface RetentionCell {
  day: number;
  /** users whose full day-N window has been observed */
  eligible: number;
  retained: number;
  rate: number | null;
  /** users excluded because their day-N window is not fully observed yet (NOT churned) */
  incomplete: number;
  ci95: { low: number; high: number } | null;
}

export interface CohortRow {
  cohort: string;
  size: number;
  cells: RetentionCell[];
}

export interface RetentionResult {
  days: number[];
  window_days: number;
  cohort_granularity: "day" | "week";
  overall: RetentionCell[];
  cohorts: CohortRow[];
  cohort_users: number;
  users_without_registration: number;
  range: string;
  segment: string;
  groups?: { dimension: SegmentDimension; values: { value: string; size: number; cells: RetentionCell[] }[]; tests: { day: number; a: string; b: string; p_value: number | null; significant: boolean }[] };
  warnings: string[];
}

export interface RetentionOptions {
  range: ResolvedRange;
  days?: number[];
  windowDays?: number;
  granularity?: "day" | "week";
  segments?: SegmentFilter;
  splitBy?: SegmentDimension;
}

/**
 * Cohort retention.
 *
 * Rules (see docs/ARCHITECTURE.md → Retention rules):
 * - Cohort = users whose registration event falls in the range. Users with no
 *   registration event are excluded and counted separately.
 * - Day N is the 24h window [reg + N·24h, reg + (N + windowDays)·24h).
 * - Retained on day N = at least one qualifying activity event in that window
 *   (app_open, lesson_completed, course_viewed, payment_initiated, purchase_completed).
 * - A user is ELIGIBLE for day N only if the whole window ends on or before the end
 *   of the last observed day. Ineligible users are excluded from the denominator,
 *   never counted as churned.
 */
export function calculateRetention(data: PreparedData, opts: RetentionOptions): RetentionResult {
  const days = opts.days ?? [1, 7, 30];
  const w = opts.windowDays ?? 1;
  const gran = opts.granularity ?? "week";
  const observedEnd = startOfDay(data.maxTs) + DAY_MS;

  const all = filterUsers(data, opts.segments);
  const noReg = all.filter((u) => u.registeredAt === null).length;
  const cohortUsers = all.filter(
    (u) => u.registeredAt !== null && u.registeredAt >= opts.range.start && u.registeredAt < opts.range.end,
  );

  const compute = (users: UserProfile[]): RetentionCell[] =>
    days.map((d) => {
      let eligible = 0;
      let retained = 0;
      let incomplete = 0;
      for (const u of users) {
        const lo = u.registeredAt! + d * DAY_MS;
        const hi = lo + w * DAY_MS;
        if (hi > observedEnd) {
          incomplete++;
          continue;
        }
        eligible++;
        if (firstInWindow(u.activity, lo, hi) !== null) retained++;
      }
      return { day: d, eligible, retained, rate: round(ratio(retained, eligible)), incomplete, ci95: wilson(retained, eligible) };
    });

  const cohortKey = (ts: number) => {
    const day = startOfDay(ts);
    if (gran === "day") return isoDay(day);
    const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
    return isoDay(day - dow * DAY_MS);
  };
  const buckets = new Map<string, UserProfile[]>();
  for (const u of cohortUsers) {
    const k = cohortKey(u.registeredAt!);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(u);
  }
  const cohorts = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, us]) => ({ cohort, size: us.length, cells: compute(us) }));

  const overall = compute(cohortUsers);
  const warnings: string[] = [];
  if (cohortUsers.length === 0) warnings.push("No users registered in this range/segment; retention is undefined.");
  for (const c of overall) {
    if (c.eligible === 0 && cohortUsers.length > 0)
      warnings.push(`Day ${c.day}: no user has a fully observed window yet; rate is null (not 0).`);
    else if (c.eligible > 0 && c.eligible < MIN_SAMPLE) warnings.push(`Day ${c.day}: small sample (${c.eligible} eligible users).`);
    if (c.incomplete > 0)
      warnings.push(`Day ${c.day}: ${c.incomplete} users excluded because their observation window is incomplete.`);
  }
  if (noReg > 0) warnings.push(`${noReg} users have events but no registration event and were excluded from cohorts.`);

  let groups: RetentionResult["groups"];
  if (opts.splitBy) {
    const dim = opts.splitBy;
    const byVal = new Map<string, UserProfile[]>();
    for (const u of cohortUsers) {
      const v = segmentValue(u, dim);
      (byVal.get(v) ?? byVal.set(v, []).get(v)!).push(u);
    }
    const values = [...byVal.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, us]) => ({ value, size: us.length, cells: compute(us) }));
    const tests: NonNullable<RetentionResult["groups"]>["tests"] = [];
    if (values.length === 2) {
      days.forEach((d, i) => {
        const a = values[0].cells[i];
        const b = values[1].cells[i];
        const t = twoProportionTest(a.retained, a.eligible, b.retained, b.eligible);
        tests.push({ day: d, a: values[0].value, b: values[1].value, p_value: t ? round(t.pValue) : null, significant: t?.significant ?? false });
      });
    }
    groups = { dimension: dim, values, tests };
  }

  return {
    days,
    window_days: w,
    cohort_granularity: gran,
    overall,
    cohorts,
    cohort_users: cohortUsers.length,
    users_without_registration: noReg,
    range: opts.range.label,
    segment: describeFilter(opts.segments),
    groups,
    warnings,
  };
}

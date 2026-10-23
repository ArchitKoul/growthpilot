import { describe, expect, it } from "vitest";
import { prepare, resolveRange, ratio } from "../core";
import { analyzeFunnel, compareFunnelPeriods } from "../funnel";
import { calculateRetention } from "../retention";
import { compareSegments, getMetricTrend } from "../metrics";
import { validateEvents } from "../quality";
import { importCsv, parseCsv, suggestMapping, toCsv } from "../csv";
import { generateExperiment } from "../experiments";
import { generateBrief } from "../brief";
import { normalCdf, sampleSizePerArm, twoProportionTest, wilson } from "../stats";
import { generateSyntheticEvents } from "../synthetic";
import { day, ev, fullFunnel } from "./fixtures";

const ALL = { preset: "all" } as const;

describe("funnel calculation", () => {
  it("S01 counts unique users per step with exact step and overall conversion", () => {
    const events = [
      ...fullFunnel("a", 0),
      ...fullFunnel("b", 0),
      ev("c", "registration", day(0)),
      ev("c", "onboarding_completed", day(0, 3)),
      ev("c", "course_viewed", day(0, 4)),
      ev("d", "registration", day(1)),
    ];
    const d = prepare(events);
    const f = analyzeFunnel(d, { range: resolveRange(ALL, d) });
    expect(f.steps.map((s) => s.users)).toEqual([4, 3, 3, 2, 2]);
    expect(f.steps[1].conversion_from_previous).toBe(0.75);
    expect(f.steps[1].drop_off_count).toBe(1);
    expect(f.steps[1].drop_off_pct).toBe(0.25);
    expect(f.steps[3].conversion_from_previous).toBe(0.6667);
    expect(f.overall_conversion).toBe(0.5);
    expect(f.biggest_drop).toMatchObject({ from: "course_viewed", to: "payment_initiated", drop_off_count: 1 });
  });

  it("S02 de-duplicates repeated events so a user is counted once per step", () => {
    const base = fullFunnel("a", 0);
    const d = prepare([...base, ...base, base[2], ev("a", "course_viewed", day(0, 30))]);
    expect(d.duplicatesRemoved).toBe(6);
    const f = analyzeFunnel(d, { range: resolveRange(ALL, d) });
    expect(f.steps.every((s) => s.users === 1)).toBe(true);
  });

  it("S03 enforces event order: steps before the previous step do not count", () => {
    const d = prepare([
      ev("a", "purchase_completed", day(0, 0)),
      ev("a", "registration", day(0, 1)),
      ev("a", "onboarding_completed", day(0, 2)),
      ev("a", "course_viewed", day(0, 3)),
      ev("a", "payment_initiated", day(0, 4)),
    ]);
    const f = analyzeFunnel(d, { range: resolveRange(ALL, d) });
    expect(f.steps.map((s) => s.users)).toEqual([1, 1, 1, 1, 0]);
  });

  it("S04 respects date range for entry and the conversion window for later steps", () => {
    const d = prepare([
      ...fullFunnel("in", 5),
      ...fullFunnel("out", 0),
      ev("late", "registration", day(5)),
      ev("late", "onboarding_completed", day(5 + 40)),
    ]);
    const r = resolveRange({ start: "2026-01-06", end: "2026-01-06" }, d);
    const f = analyzeFunnel(d, { range: r, conversionWindowDays: 30 });
    expect(f.entrants).toBe(2);
    expect(f.steps[1].users).toBe(1); // 'late' onboarded after the 30-day window
  });

  it("S05 returns null rates (not 0/NaN) for zero denominators", () => {
    const d = prepare([ev("a", "registration", day(0))]);
    const f = analyzeFunnel(d, { range: resolveRange(ALL, d), segments: { platform: ["android"] } });
    expect(f.entrants).toBe(0);
    expect(f.overall_conversion).toBeNull();
    expect(f.steps[1].conversion_from_previous).toBeNull();
    expect(f.warnings[0]).toMatch(/No users entered/);
    expect(ratio(0, 0)).toBeNull();
  });

  it("S06 flags small samples and immature conversion windows", () => {
    const d = prepare([...fullFunnel("a", 0), ev("b", "registration", day(0))]);
    const f = analyzeFunnel(d, { range: resolveRange(ALL, d) });
    expect(f.warnings.join(" ")).toMatch(/Small sample/);
    expect(f.immature_entrants).toBe(2);
  });

  it("S07 compares periods and tests step changes", () => {
    const prev = Array.from({ length: 40 }, (_, i) => fullFunnel(`p${i}`, 0)).flat();
    const cur = Array.from({ length: 40 }, (_, i) =>
      i < 10 ? fullFunnel(`c${i}`, 1) : fullFunnel(`c${i}`, 1).filter((e) => e.event_name !== "purchase_completed"),
    ).flat();
    const d = prepare([...prev, ...cur]);
    const c = compareFunnelPeriods(d, { range: resolveRange({ start: "2026-01-02", end: "2026-01-02" }, d) });
    const last = c.step_changes.at(-1)!;
    expect(last.current_rate).toBe(0.25);
    expect(last.previous_rate).toBe(1);
    expect(last.significant).toBe(true);
  });
});

describe("retention calculation", () => {
  it("S08 computes D1/D7/D30 from qualifying activity only", () => {
    const d = prepare([
      ev("a", "registration", day(0)),
      ev("a", "app_open", day(1, 60)),
      ev("a", "lesson_completed", day(7, 60)),
      ev("a", "app_open", day(30, 60)),
      ev("b", "registration", day(0)),
      ev("b", "onboarding_completed", day(1, 60)), // not qualifying activity
      ev("z", "app_open", day(60)), // extends observation window
    ]);
    const r = calculateRetention(d, { range: resolveRange({ start: "2026-01-01", end: "2026-01-01" }, d) });
    expect(r.overall.map((c) => [c.eligible, c.retained, c.rate])).toEqual([
      [2, 1, 0.5],
      [2, 1, 0.5],
      [2, 1, 0.5],
    ]);
    expect(r.users_without_registration).toBe(1);
  });

  it("S09 excludes users with incomplete observation windows instead of counting them as churned", () => {
    const d = prepare([
      ev("old", "registration", day(0)),
      ev("old", "app_open", day(7, 10)),
      ev("new", "registration", day(25)),
      ev("new", "app_open", day(27)),
    ]);
    const r = calculateRetention(d, { range: resolveRange(ALL, d), days: [7, 30] });
    const d7 = r.overall[0];
    const d30 = r.overall[1];
    expect(d7).toMatchObject({ eligible: 1, retained: 1, rate: 1, incomplete: 1 });
    expect(d30).toMatchObject({ eligible: 0, retained: 0, rate: null, incomplete: 2 });
    expect(r.warnings.join(" ")).toMatch(/rate is null \(not 0\)/);
  });

  it("S10 compares onboarding completers vs non-completers with a significance test", () => {
    const evs = [];
    for (let i = 0; i < 60; i++) {
      evs.push(ev(`c${i}`, "registration", day(0)), ev(`c${i}`, "onboarding_completed", day(0, 5)));
      if (i < 30) evs.push(ev(`c${i}`, "app_open", day(7, 30)));
      evs.push(ev(`n${i}`, "registration", day(0)));
      if (i < 6) evs.push(ev(`n${i}`, "app_open", day(7, 30)));
    }
    evs.push(ev("z", "app_open", day(20)));
    const d = prepare(evs);
    const r = calculateRetention(d, { range: resolveRange({ start: "2026-01-01", end: "2026-01-01" }, d), days: [7], splitBy: "onboarding_status" });
    const [completed, notCompleted] = r.groups!.values;
    expect(completed.cells[0].rate).toBe(0.5);
    expect(notCompleted.cells[0].rate).toBe(0.1);
    expect(r.groups!.tests[0].significant).toBe(true);
  });

  it("S11 groups cohorts by ISO week (Monday start)", () => {
    // 2026-01-01 is a Thursday → week of 2025-12-29
    const d = prepare([ev("a", "registration", day(0)), ev("b", "registration", day(4)), ev("z", "app_open", day(50))]);
    const r = calculateRetention(d, { range: resolveRange(ALL, d), days: [1] });
    expect(r.cohorts.map((c) => [c.cohort, c.size])).toEqual([
      ["2025-12-29", 1],
      ["2026-01-05", 1],
    ]);
  });
});

describe("metrics and segments", () => {
  it("S12 purchase conversion counts purchases only at/after the first in-period view", () => {
    const d = prepare([
      ev("a", "course_viewed", day(0, 0)),
      ev("a", "purchase_completed", day(0, 5)),
      ev("b", "purchase_completed", day(0, 0)),
      ev("b", "course_viewed", day(0, 5)),
      ev("c", "course_viewed", day(0, 1)),
    ]);
    const t = getMetricTrend(d, "purchase_conversion", resolveRange(ALL, d));
    expect(t.current).toEqual({ value: 0.3333, numerator: 1, denominator: 3 });
  });

  it("S13 trend compares with the previous equal-length period", () => {
    const evs = [];
    for (let i = 0; i < 10; i++) evs.push(ev(`p${i}`, "registration", day(0)));
    for (let i = 0; i < 15; i++) evs.push(ev(`c${i}`, "registration", day(1)));
    const d = prepare(evs);
    const t = getMetricTrend(d, "registrations", resolveRange({ start: "2026-01-02", end: "2026-01-02" }, d));
    expect(t.current.value).toBe(15);
    expect(t.previous.value).toBe(10);
    expect(t.absolute_change).toBe(5);
    expect(t.relative_change).toBe(0.5);
  });

  it("S14 compares segments with denominators, CIs and tests vs rest", () => {
    const evs = [];
    for (let i = 0; i < 100; i++) {
      evs.push(ev(`a${i}`, "course_viewed", day(0), { platform: "android" }));
      if (i < 10) evs.push(ev(`a${i}`, "purchase_completed", day(0, 3), { platform: "android" }));
      evs.push(ev(`i${i}`, "course_viewed", day(0), { platform: "ios" }));
      if (i < 30) evs.push(ev(`i${i}`, "purchase_completed", day(0, 3), { platform: "ios" }));
    }
    const d = prepare(evs);
    const s = compareSegments(d, "purchase_conversion", "platform", resolveRange(ALL, d));
    const android = s.rows.find((r) => r.segment === "android")!;
    expect(android).toMatchObject({ numerator: 10, denominator: 100, rate: 0.1, diff_vs_rest: -0.2, significant_vs_rest: true });
    expect(s.best).toBe("ios");
    expect(s.worst).toBe("android");
    expect(s.spread).toBe(0.2);
  });

  it("S15 excludes small segments from best/worst and warns", () => {
    const evs = [];
    for (let i = 0; i < 50; i++) {
      evs.push(ev(`i${i}`, "course_viewed", day(0), { platform: "ios" }));
      if (i < 10) evs.push(ev(`i${i}`, "purchase_completed", day(0, 1), { platform: "ios" }));
    }
    for (let i = 0; i < 5; i++) {
      evs.push(ev(`w${i}`, "course_viewed", day(0), { platform: "web" }));
      evs.push(ev(`w${i}`, "purchase_completed", day(0, 1), { platform: "web" }));
    }
    const d = prepare(evs);
    const s = compareSegments(d, "purchase_conversion", "platform", resolveRange(ALL, d));
    expect(s.rows.find((r) => r.segment === "web")!.small_sample).toBe(true);
    expect(s.best).toBe("ios"); // web at 100% is not trusted with n=5
    expect(s.warnings.join(" ")).toMatch(/only 5 users/);
  });

  it("S16 retention-by-segment uses eligibility rules and supports acquisition channel", () => {
    const evs = [];
    for (let i = 0; i < 40; i++) {
      evs.push(ev(`o${i}`, "registration", day(0), { channel: "organic" }));
      if (i < 20) evs.push(ev(`o${i}`, "app_open", day(7, 30), { channel: "organic" }));
      evs.push(ev(`p${i}`, "registration", day(0), { channel: "paid" }));
      if (i < 8) evs.push(ev(`p${i}`, "app_open", day(7, 30), { channel: "paid" }));
    }
    evs.push(ev("z", "app_open", day(10)));
    const d = prepare(evs);
    const s = compareSegments(d, "d7_retention", "acquisition_channel", resolveRange(ALL, d));
    expect(s.rows.map((r) => [r.segment, r.rate, r.denominator])).toEqual([
      ["organic", 0.5, 40],
      ["paid", 0.2, 40],
    ]);
  });
});

describe("data quality and CSV", () => {
  it("S17 detects duplicates, missing values, events before registration and future timestamps", () => {
    const e = ev("a", "registration", day(1));
    const report = validateEvents("t", [
      e,
      e,
      ev("a", "app_open", day(0)),
      ev("b", "purchase_completed", day(1), { revenue: null, category: null, session: null }),
      ev("c", "app_open", day(5000)),
    ], { now: day(2) });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.count]));
    expect(byId.duplicates).toBe(1);
    expect(byId.events_before_registration).toBe(1);
    expect(byId.purchase_missing_revenue).toBe(1);
    expect(byId.missing_category).toBe(1);
    expect(byId.future_timestamps).toBe(1);
    expect(byId.users_without_registration).toBe(2);
    expect(report.status).toBe("errors");
  });

  it("S18 parses CSV with quotes, suggests mappings, and rejects invalid rows with reasons", () => {
    const csv = [
      "User ID,Event,time,OS,channel,category,session,amount",
      'u1,registration,2026-01-01T10:00:00Z,iOS,organic,,"s,1",',
      "u1,purchase_completed,2026-01-01T10:05:00Z,ios,organic,crypto,s1,59",
      "u2,teleport,2026-01-01T10:00:00Z,ios,organic,,,",
      "u3,registration,03/04/2026,ios,organic,,,",
      "u4,registration,2026-01-01,blackberry,organic,,,",
    ].join("\n");
    const rows = parseCsv(csv);
    expect(rows[1][6]).toBe("s,1");
    const mapping = suggestMapping(rows[0]);
    expect(mapping).toMatchObject({ user_id: "User ID", event_name: "Event", timestamp: "time", platform: "OS", revenue: "amount" });
    const res = importCsv(rows, mapping);
    expect(res.events).toHaveLength(2);
    expect(res.events[1].revenue).toBe(59);
    expect(res.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(res.errors[1].message).toMatch(/invalid timestamp/);
  });

  it("S19 reports missing required column mappings instead of guessing", () => {
    const res = importCsv(parseCsv("a,b\n1,2"), suggestMapping(["a", "b"]));
    expect(res.events).toHaveLength(0);
    expect(res.missingRequired).toContain("user_id");
  });

  it("S20 round-trips the synthetic dataset through CSV export/import", () => {
    const events = generateSyntheticEvents({ days: 5, usersPerDay: 5, duplicateRate: 0 });
    const rows = parseCsv(toCsv(events));
    const res = importCsv(rows, suggestMapping(rows[0]));
    expect(res.errors).toHaveLength(0);
    expect(res.events).toEqual(events);
  });
});

describe("statistics, experiments and briefs", () => {
  it("S21 statistics helpers match known reference values", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    const w = wilson(50, 100)!;
    expect(w.low).toBeCloseTo(0.4038, 3);
    expect(w.high).toBeCloseTo(0.5962, 3);
    expect(wilson(0, 0)).toBeNull();
    expect(twoProportionTest(0, 0, 5, 10)).toBeNull();
    expect(twoProportionTest(10, 100, 30, 100)!.pValue).toBeLessThan(0.001);
    // reference: p1 = 0.10, p2 = 0.12 → ≈ 3,841 per arm
    expect(sampleSizePerArm(0.1, 0.02)).toBeGreaterThan(3800);
    expect(sampleSizePerArm(0.1, 0.02)).toBeLessThan(3900);
  });

  it("S22 experiment output has every required field and no causal guarantees", () => {
    const exp = generateExperiment(
      {
        title: "Android payment completion dropped",
        statement: "Android payment completion fell in the last 7 days.",
        metric: "step_conversion",
        segment: { dimension: "platform", value: "android" },
        funnel_step: { from: "payment_initiated", to: "purchase_completed" },
        baseline_rate: 0.43,
        comparison_rate: 0.745,
        sample_size: 86,
        analysed_days: 7,
        evidence: ["analyze_funnel#3: android payment→purchase 43.0% vs 74.5%"],
      },
      "payment_initiated → purchase_completed conversion",
    );
    for (const k of ["problem_statement", "hypothesis", "proposed_change", "target_segment", "primary_metric", "support_conditions", "reject_conditions", "causal_caveat"] as const)
      expect(exp[k].length).toBeGreaterThan(10);
    expect(exp.guardrail_metrics.length).toBeGreaterThan(0);
    expect(exp.design.minimum_detectable_effect).toBe(0.1);
    expect(exp.design.sample_size_per_arm).toBeGreaterThan(0);
    expect(exp.risks.join(" ")).toMatch(/fixed directly/);
    expect(exp.risks.join(" ")).toMatch(/Small evidence base/);
    expect(`${exp.hypothesis} ${exp.causal_caveat}`).not.toMatch(/guarantee/i);
    const md = generateBrief(exp, { datasetId: "x", datasetName: "X" });
    for (const h of ["Context and user problem", "Supporting data", "Proposed solution", "Requirements", "Acceptance criteria", "Success metrics", "Dependencies and risks"])
      expect(md).toContain(h);
  });

  it("S23 rejects malformed findings", () => {
    expect(() =>
      generateExperiment({ title: "x", statement: "bad", metric: "purchase_conversion", baseline_rate: 1.4, sample_size: 10, evidence: [] } as never, "m"),
    ).toThrow();
  });
});

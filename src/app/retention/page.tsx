"use client";

import { useMemo, useState } from "react";
import { useData } from "@/components/data-context";
import { useRange } from "@/components/use-range";
import { FilterBar } from "@/components/filter-bar";
import { RetentionHeatmap } from "@/components/charts";
import { Badge, Card, Empty, Loading, Notice, PageHeader, Select, Stat, Warnings, fmtNum, fmtPct, label } from "@/components/ui";
import { calculateRetention } from "@/lib/analytics/retention";
import type { SegmentDimension } from "@/lib/analytics/core";

export default function RetentionPage() {
  const { prepared, segmentFilter } = useData();
  const { range, error } = useRange();
  const [split, setSplit] = useState<SegmentDimension | "none">("onboarding_status");
  const [gran, setGran] = useState<"week" | "day">("week");

  const r = useMemo(
    () =>
      prepared && range
        ? calculateRetention(prepared, { range, segments: segmentFilter, days: [1, 7, 30], granularity: gran, splitBy: split === "none" ? undefined : split })
        : null,
    [prepared, range, segmentFilter, split, gran],
  );

  return (
    <>
      <PageHeader title="Retention" description="Registration-cohort retention. Users whose Day-N window is not yet fully observed are excluded — not counted as churned." />
      <FilterBar showCategory={false} />
      <div className="mb-6 flex flex-wrap gap-3">
        <Select label="Compare by" value={split} onChange={(e) => setSplit(e.target.value as SegmentDimension | "none")}>
          <option value="none">No split</option>
          <option value="onboarding_status">Onboarding completion</option>
          <option value="platform">Platform</option>
          <option value="acquisition_channel">Acquisition channel</option>
          <option value="course_category">First course category</option>
        </Select>
        <Select label="Cohort granularity" value={gran} onChange={(e) => setGran(e.target.value as "week" | "day")}>
          <option value="week">Weekly</option>
          <option value="day">Daily</option>
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {!r && !error && <Loading />}
      {r && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {r.overall.map((c) => (
              <Stat
                key={c.day}
                label={`Day ${c.day} retention`}
                value={fmtPct(c.rate)}
                sub={
                  c.eligible
                    ? `${fmtNum(c.retained)}/${fmtNum(c.eligible)} · 95% CI ${fmtPct(c.ci95?.low)}–${fmtPct(c.ci95?.high)} · ${fmtNum(c.incomplete)} pending`
                    : `No user has a complete Day-${c.day} window (${fmtNum(c.incomplete)} pending)`
                }
              />
            ))}
          </div>

          {r.groups && (
            <Card title={`Retention by ${label(r.groups.dimension)}`} subtitle="Rates use only users with fully observed windows">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="py-2 font-medium">Segment</th>
                      <th className="py-2 text-right font-medium">Cohort users</th>
                      {r.days.map((d) => <th key={d} className="py-2 text-right font-medium">Day {d} (eligible)</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.groups.values.map((v) => (
                      <tr key={v.value}>
                        <td className="py-2">{label(v.value)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtNum(v.size)}</td>
                        {v.cells.map((c) => (
                          <td key={c.day} className="py-2 text-right tabular-nums">
                            {fmtPct(c.rate)} <span className="text-xs text-muted">({fmtNum(c.eligible)})</span>
                            {c.eligible > 0 && c.eligible < 30 && <Badge tone="warn">small</Badge>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {r.groups.tests.length > 0 && (
                <p className="mt-3 text-xs text-ink-2">
                  Significance ({r.groups.tests[0].a} vs {r.groups.tests[0].b}):{" "}
                  {r.groups.tests.map((t) => `Day ${t.day} p = ${t.p_value ?? "n/a"}${t.significant ? " (significant)" : ""}`).join(" · ")}
                </p>
              )}
              {r.groups.dimension === "onboarding_status" && (
                <p className="mt-2 text-xs text-muted">Onboarding is self-selected: the gap shows correlation, not the causal effect of onboarding.</p>
              )}
            </Card>
          )}

          <Card title="Cohort table" subtitle={`${r.cohorts.length} ${gran === "week" ? "weekly" : "daily"} cohorts · ${fmtNum(r.cohort_users)} users · “pending” = window not fully observed`}>
            {r.cohorts.length ? <RetentionHeatmap cohorts={r.cohorts} days={r.days} /> : <Empty title="No cohorts in this range" />}
            <Warnings items={r.warnings.slice(0, 6)} />
          </Card>

          <Card title="Retention rules">
            <ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">
              <li>Cohort = users whose <code>registration</code> falls in the date range (users without a registration event are excluded and reported).</li>
              <li>Day N = the 24-hour window starting N×24h after the registration timestamp.</li>
              <li>Qualifying activity: app_open, lesson_completed, course_viewed, payment_initiated, purchase_completed. Registration and onboarding do not count.</li>
              <li>A user is eligible for Day N only if their whole Day-N window ends before the end of the last observed day; otherwise they are “pending”, not churned.</li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

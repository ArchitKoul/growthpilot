"use client";

import { useMemo, useState } from "react";
import { useData } from "@/components/data-context";
import { useRange } from "@/components/use-range";
import { FilterBar } from "@/components/filter-bar";
import { FunnelChart } from "@/components/charts";
import { Badge, Card, Empty, Loading, Notice, PageHeader, Select, Warnings, fmtNum, fmtPct, label } from "@/components/ui";
import { compareFunnelPeriods } from "@/lib/analytics/funnel";
import { DEFAULT_FUNNEL, type EventName } from "@/lib/analytics/schema";

const SEQUENCES: Record<string, { label: string; steps: EventName[] }> = {
  full: { label: "Registration → Purchase (5 steps)", steps: DEFAULT_FUNNEL },
  checkout: { label: "Course view → Purchase (checkout)", steps: ["course_viewed", "payment_initiated", "purchase_completed"] },
  activation: { label: "Registration → Course view", steps: ["registration", "onboarding_completed", "course_viewed"] },
};

export default function FunnelPage() {
  const { prepared, segmentFilter } = useData();
  const { range, error } = useRange();
  const [seq, setSeq] = useState("full");
  const [windowDays, setWindowDays] = useState(30);

  const res = useMemo(
    () => (prepared && range ? compareFunnelPeriods(prepared, { range, segments: segmentFilter, steps: SEQUENCES[seq].steps, conversionWindowDays: windowDays }) : null),
    [prepared, range, segmentFilter, seq, windowDays],
  );
  const f = res?.current;

  return (
    <>
      <PageHeader title="Funnel analysis" description="Ordered, user-level funnel with step conversion, drop-offs and a significance-tested comparison to the previous period." />
      <FilterBar />
      <div className="mb-6 flex flex-wrap gap-3">
        <Select label="Funnel" value={seq} onChange={(e) => setSeq(e.target.value)}>
          {Object.entries(SEQUENCES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <Select label="Conversion window" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
          {[1, 7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} days</option>)}
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {!res && !error && <Loading />}
      {f && res && (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3" title="Funnel" subtitle={`${f.range} · ${f.segment}`}>
              {f.entrants ? <FunnelChart steps={f.steps} /> : <Empty title="No users entered this funnel">Try a wider date range or fewer filters.</Empty>}
              <Warnings items={f.warnings} />
            </Card>
            <Card className="lg:col-span-2" title="Headline">
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between"><dt className="text-ink-2">Entrants</dt><dd className="font-semibold tabular-nums">{fmtNum(f.entrants)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-2">Completed</dt><dd className="font-semibold tabular-nums">{fmtNum(f.completers)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-2">Overall conversion</dt><dd className="font-semibold tabular-nums">{fmtPct(f.overall_conversion)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-2">Previous period</dt><dd className="tabular-nums">{fmtPct(res.previous.overall_conversion)}</dd></div>
                {f.biggest_drop && (
                  <div className="rounded-lg bg-bad-soft p-3 text-bad">
                    Biggest drop-off: <strong>{label(f.biggest_drop.from)} → {label(f.biggest_drop.to)}</strong> — {fmtNum(f.biggest_drop.drop_off_count)} users ({fmtPct(f.biggest_drop.drop_off_pct)})
                  </div>
                )}
              </dl>
            </Card>
          </div>

          <Card title="Step detail vs previous period" subtitle={`Previous period: ${res.previous.range}. Two-proportion z-test, α = 0.05.`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-2 font-medium">Step</th>
                    <th className="py-2 text-right font-medium">Users</th>
                    <th className="py-2 text-right font-medium">Step conv.</th>
                    <th className="py-2 text-right font-medium">Drop-off</th>
                    <th className="py-2 text-right font-medium">Prev. step conv.</th>
                    <th className="py-2 text-right font-medium">Change</th>
                    <th className="py-2 text-right font-medium">p-value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {f.steps.map((s, i) => {
                    const ch = i > 0 ? res.step_changes[i - 1] : null;
                    return (
                      <tr key={s.step}>
                        <td className="py-2">{label(s.step)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtNum(s.users)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtPct(s.conversion_from_previous)}</td>
                        <td className="py-2 text-right tabular-nums">{i ? `${fmtNum(s.drop_off_count)} (${fmtPct(s.drop_off_pct)})` : "—"}</td>
                        <td className="py-2 text-right tabular-nums">{fmtPct(ch?.previous_rate)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {ch?.absolute_change !== null && ch?.absolute_change !== undefined ? `${ch.absolute_change >= 0 ? "+" : ""}${(ch.absolute_change * 100).toFixed(1)} pp` : "—"}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {ch?.p_value ?? "—"} {ch?.significant && <Badge tone={(ch.absolute_change ?? 0) < 0 ? "bad" : "good"}>sig.</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Calculation rules">
            <ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">
              <li>Identity is <code>user_id</code>; exact duplicate events (same user, event, timestamp) are removed first.</li>
              <li>A user enters on their first <code>{SEQUENCES[seq].steps[0]}</code> event inside the date range.</li>
              <li>Each later step counts only if it happens at or after the previous step, within {windowDays} days of entry. Out-of-order events do not count.</li>
              <li>Each user is counted at most once per step. Rates with a zero denominator show “—”, never 0%.</li>
              <li>Entrants whose window extends past the last observed event are flagged as immature.</li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

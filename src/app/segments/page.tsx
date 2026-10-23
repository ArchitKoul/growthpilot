"use client";

import { useMemo, useState } from "react";
import { useData } from "@/components/data-context";
import { useRange } from "@/components/use-range";
import { FilterBar } from "@/components/filter-bar";
import { SegmentChart } from "@/components/charts";
import { Badge, Card, Loading, Notice, PageHeader, Select, Warnings, fmtNum, fmtPct, label } from "@/components/ui";
import { compareSegments, SEGMENT_METRICS, type SegmentMetric } from "@/lib/analytics/metrics";
import { SEGMENT_DIMENSIONS, type SegmentDimension } from "@/lib/analytics/core";

export default function SegmentsPage() {
  const { prepared, segmentFilter } = useData();
  const { range, error } = useRange();
  const [metric, setMetric] = useState<SegmentMetric>("purchase_conversion");
  const [dim, setDim] = useState<SegmentDimension>("platform");

  const c = useMemo(() => (prepared && range ? compareSegments(prepared, metric, dim, range, segmentFilter) : null), [prepared, range, metric, dim, segmentFilter]);

  return (
    <>
      <PageHeader title="Segment analysis" description="Compare a metric across platforms, acquisition channels, course categories or onboarding status — with denominators, confidence intervals and significance tests." />
      <FilterBar />
      <div className="mb-6 flex flex-wrap gap-3">
        <Select label="Metric" value={metric} onChange={(e) => setMetric(e.target.value as SegmentMetric)}>
          {SEGMENT_METRICS.map((m) => <option key={m} value={m}>{label(m)}</option>)}
        </Select>
        <Select label="Segment by" value={dim} onChange={(e) => setDim(e.target.value as SegmentDimension)}>
          {SEGMENT_DIMENSIONS.map((d) => <option key={d} value={d}>{label(d)}</option>)}
        </Select>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {!c && !error && <Loading />}
      {c && (
        <div className="space-y-6">
          <Card title={`${label(c.metric)} by ${label(c.dimension)}`} subtitle={`${c.definition} · ${c.range} · base: ${c.base_filter}`}>
            <SegmentChart rows={c.rows} />
            <p className="mt-2 text-xs text-muted">Error bars: 95% Wilson interval. Grey bars: fewer than 30 users (not used for best/worst).</p>
          </Card>
          <Card title="Detail">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-2 font-medium">Segment</th>
                    <th className="py-2 text-right font-medium">Numerator</th>
                    <th className="py-2 text-right font-medium">Denominator</th>
                    <th className="py-2 text-right font-medium">Rate</th>
                    <th className="py-2 text-right font-medium">95% CI</th>
                    <th className="py-2 text-right font-medium">vs rest</th>
                    <th className="py-2 text-right font-medium">p-value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {c.rows.map((r) => (
                    <tr key={r.segment}>
                      <td className="py-2">
                        {label(r.segment)} {r.segment === c.best && <Badge tone="good">best</Badge>} {r.segment === c.worst && <Badge tone="bad">worst</Badge>}
                        {r.small_sample && <Badge tone="warn">small sample</Badge>}
                      </td>
                      <td className="py-2 text-right tabular-nums">{fmtNum(r.numerator)}</td>
                      <td className="py-2 text-right tabular-nums">{fmtNum(r.denominator)}</td>
                      <td className="py-2 text-right font-medium tabular-nums">{fmtPct(r.rate)}</td>
                      <td className="py-2 text-right tabular-nums text-ink-2">{r.ci95 ? `${fmtPct(r.ci95.low)}–${fmtPct(r.ci95.high)}` : "—"}</td>
                      <td className="py-2 text-right tabular-nums">{r.diff_vs_rest !== null ? `${r.diff_vs_rest >= 0 ? "+" : ""}${(r.diff_vs_rest * 100).toFixed(1)} pp` : "—"}</td>
                      <td className="py-2 text-right tabular-nums">{r.p_value_vs_rest ?? "—"} {r.significant_vs_rest && <Badge tone="accent">sig.</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Warnings items={c.warnings} />
            <p className="mt-3 text-xs text-muted">Segment differences are observational. They show where to look, not what causes the difference.</p>
          </Card>
        </div>
      )}
    </>
  );
}

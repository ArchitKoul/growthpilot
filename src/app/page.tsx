"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useData } from "@/components/data-context";
import { useRange } from "@/components/use-range";
import { FilterBar } from "@/components/filter-bar";
import { Badge, Card, Empty, Loading, Notice, PageHeader, Stat, fmtMoney, fmtNum, fmtPct, label } from "@/components/ui";
import { FunnelChart, RetentionHeatmap, TrendChart } from "@/components/charts";
import { getMetricTrend, type TrendMetric } from "@/lib/analytics/metrics";
import { analyzeFunnel } from "@/lib/analytics/funnel";
import { calculateRetention } from "@/lib/analytics/retention";

function delta(cur: number | null, prev: number | null, isRate: boolean, partial = false) {
  if (partial) return { text: "prev. period not fully in dataset", tone: "neutral" as const };
  if (cur === null || prev === null) return { text: "no comparison", tone: "neutral" as const };
  const d = cur - prev;
  const tone = d > 0 ? ("good" as const) : d < 0 ? ("bad" as const) : ("neutral" as const);
  const text = isRate
    ? `${d >= 0 ? "+" : "−"}${(Math.abs(d) * 100).toFixed(1)} pp vs prev. period`
    : prev === 0
      ? "prev. period 0"
      : `${d >= 0 ? "+" : "−"}${Math.abs((d / prev) * 100).toFixed(1)}% vs prev. period`;
  return { text, tone };
}

export default function Overview() {
  const { prepared, segmentFilter, investigations, active } = useData();
  const { range, error } = useRange();

  const m = useMemo(() => {
    if (!prepared || !range) return null;
    const t = (k: TrendMetric) => getMetricTrend(prepared, k, range, segmentFilter);
    return {
      registrations: t("registrations"),
      active: t("active_users"),
      views: t("course_views"),
      purchases: t("purchases"),
      revenue: t("revenue"),
      conversion: t("purchase_conversion"),
      funnel: analyzeFunnel(prepared, { range, segments: segmentFilter }),
      retention: calculateRetention(prepared, { range, segments: segmentFilter, days: [1, 7, 30] }),
    };
  }, [prepared, range, segmentFilter]);

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Key product metrics for ${active?.meta.name ?? "the active dataset"}. Every number is computed live from the event data.`}
        actions={
          <Link href="/investigate" className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white hover:bg-ink/90">
            New investigation
          </Link>
        }
      />
      <FilterBar />
      {error && <Notice tone="bad">{error}</Notice>}
      {!m && !error && <Loading label="Computing metrics from events…" />}
      {m && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                ["Registered users", m.registrations, false],
                ["Active users", m.active, false],
                ["Course views", m.views, false],
                ["Successful purchases", m.purchases, false],
              ] as const
            ).map(([l, t, r]) => {
              const d = delta(t.current.value, t.previous.value, r, t.warnings.some((w) => w.includes("partially observed")));
              return <Stat key={l} label={l} value={fmtNum(t.current.value)} sub={d.text} tone={d.tone} />;
            })}
            {(() => {
              const d = delta(m.conversion.current.value, m.conversion.previous.value, true, m.conversion.warnings.some((w) => w.includes("partially observed")));
              return (
                <Stat
                  label="Purchase conversion"
                  value={fmtPct(m.conversion.current.value)}
                  sub={`${d.text}${m.conversion.significant === false ? " (n.s.)" : m.conversion.significant ? " · significant" : ""}`}
                  tone={d.tone}
                />
              );
            })()}
            <Stat label="Revenue" value={fmtMoney(m.revenue.current.value)} sub={delta(m.revenue.current.value, m.revenue.previous.value, false, m.revenue.warnings.some((w) => w.includes("partially observed"))).text} />
            {m.retention.overall
              .filter((c) => c.day !== 1)
              .map((c) => (
                <Stat
                  key={c.day}
                  label={`Day ${c.day} retention`}
                  value={fmtPct(c.rate)}
                  sub={c.eligible ? `${fmtNum(c.retained)}/${fmtNum(c.eligible)} eligible · ${fmtNum(c.incomplete)} pending` : "No cohort fully observed yet"}
                />
              ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Purchase conversion" subtitle="Daily · viewers who purchased after viewing">
              <TrendChart data={m.conversion.series} isRate name="Purchase conversion" />
            </Card>
            <Card title="Registrations & active users" subtitle="Daily counts">
              <TrendChart data={m.active.series} name="Active users" height={105} />
              <TrendChart data={m.registrations.series} name="Registrations" height={105} color="var(--series-2)" />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-2" title="Purchase funnel" subtitle={`${fmtNum(m.funnel.entrants)} registrants · ${fmtPct(m.funnel.overall_conversion)} overall`} actions={<Link href="/funnel" className="text-xs text-accent">Details →</Link>}>
              {m.funnel.entrants ? <FunnelChart steps={m.funnel.steps} /> : <Empty title="No registrations in this range" />}
            </Card>
            <Card className="lg:col-span-3" title="Retention cohorts" subtitle="Most recent weekly cohorts" actions={<Link href="/retention" className="text-xs text-accent">Details →</Link>}>
              {m.retention.cohorts.length ? (
                <RetentionHeatmap cohorts={m.retention.cohorts.slice(-8)} days={m.retention.days} />
              ) : (
                <Empty title="No cohorts in this range" />
              )}
            </Card>
          </div>

          <Card title="Recent investigations" actions={<Link href="/investigate" className="text-xs text-accent">Open workspace →</Link>}>
            {investigations.length === 0 ? (
              <Empty title="No investigations yet">Ask a question in the investigation workspace to get an evidence-backed report.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {investigations.slice(0, 5).map((r) => (
                  <li key={r.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <Link href={`/investigate?id=${r.id}`} className="text-sm text-ink hover:text-accent">{r.question}</Link>
                    <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
                      <Badge tone={r.mode === "live" ? "good" : "warn"}>{r.mode === "live" ? "Live AI" : "Demo"}</Badge>
                      <Badge>{label(r.report.answer_status)}</Badge>
                      {new Date(r.started_at).toLocaleDateString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

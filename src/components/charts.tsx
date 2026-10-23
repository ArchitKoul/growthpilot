"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ErrorBar,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from "recharts";
import type { FunnelStep } from "@/lib/analytics/funnel";
import type { CohortRow } from "@/lib/analytics/retention";
import type { SegmentRow } from "@/lib/analytics/metrics";
import { fmtNum, fmtPct, label } from "./ui";

const tooltipStyle = {
  contentStyle: { borderRadius: 8, border: "1px solid var(--border)", fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,.06)" },
  labelStyle: { color: "var(--text)", fontWeight: 600 },
};

export function TrendChart({
  data,
  isRate,
  height = 220,
  color = "var(--series-1)",
  name,
}: {
  data: { date: string; value: number | null; numerator?: number; denominator?: number }[];
  isRate?: boolean;
  height?: number;
  color?: string;
  name: string;
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis
            tickFormatter={(v: number) => (isRate ? `${Math.round(v * 100)}%` : fmtNum(v))}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            {...tooltipStyle}
            formatter={(v, _n, item) => {
              const p = item.payload as { numerator?: number; denominator?: number };
              const val = typeof v === "number" ? (isRate ? fmtPct(v) : fmtNum(v)) : "—";
              return [p.denominator !== undefined ? `${val} (${p.numerator}/${p.denominator})` : val, name];
            }}
          />
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = steps[0]?.users || 1;
  return (
    <div className="space-y-3">
      {steps.map((s, i) => (
        <div key={s.step}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium text-ink">
              <span className="mr-2 text-xs text-muted">{i + 1}</span>
              {label(s.step)}
            </span>
            <span className="tabular-nums text-ink-2">
              {fmtNum(s.users)} <span className="text-muted">· {fmtPct(s.conversion_from_start)} of start</span>
            </span>
          </div>
          <div className="h-7 w-full rounded-md bg-surface-2">
            <div
              className="h-7 rounded-md bg-[var(--series-1)] transition-all"
              style={{ width: `${Math.max(0.5, (s.users / max) * 100)}%` }}
              title={`${s.users} users`}
            />
          </div>
          {i > 0 && (
            <div className="mt-1 text-xs text-muted">
              {fmtPct(s.conversion_from_previous)} from previous step · <span className="text-bad">−{fmtNum(s.drop_off_count)} dropped ({fmtPct(s.drop_off_pct)})</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SegmentChart({ rows, height = 220 }: { rows: SegmentRow[]; height?: number }) {
  const data = rows.map((r) => ({
    segment: label(r.segment),
    rate: r.rate,
    err: r.ci95 && r.rate !== null ? [r.rate - r.ci95.low, r.ci95.high - r.rate] : [0, 0],
    small: r.small_sample,
    n: r.denominator,
    num: r.numerator,
  }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="segment" tickLine={false} axisLine={false} interval={0} />
          <YAxis tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} width={44} />
          <Tooltip
            {...tooltipStyle}
            cursor={{ fill: "var(--surface-2)" }}
            formatter={(v, _n, item) => {
              const p = item.payload as { num: number; n: number; small: boolean };
              return [`${fmtPct(typeof v === "number" ? v : null)} (${p.num}/${p.n})${p.small ? " · small sample" : ""}`, "Rate"];
            }}
          />
          <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.small ? "var(--muted)" : "var(--series-1)"} />
            ))}
            <ErrorBar dataKey="err" width={6} stroke="var(--text-2)" strokeWidth={1} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Sequential single-hue heatmap; null cells (incomplete windows) are hatched-out, not zero. */
export function RetentionHeatmap({ cohorts, days }: { cohorts: CohortRow[]; days: number[] }) {
  const shade = (r: number | null) => (r === null ? undefined : `color-mix(in oklab, var(--series-1) ${Math.round(8 + r * 92)}%, white)`);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] border-separate border-spacing-[2px] text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="px-2 py-1 font-medium">Cohort (week of)</th>
            <th className="px-2 py-1 text-right font-medium">Users</th>
            {days.map((d) => (
              <th key={d} className="px-2 py-1 text-center font-medium">Day {d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.cohort}>
              <td className="px-2 py-1.5 tabular-nums text-ink-2">{c.cohort}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">{fmtNum(c.size)}</td>
              {c.cells.map((cell) => (
                <td
                  key={cell.day}
                  className="rounded px-2 py-1.5 text-center tabular-nums"
                  style={{ background: shade(cell.rate), color: cell.rate !== null && cell.rate > 0.45 ? "white" : undefined }}
                  title={cell.rate === null ? `${cell.incomplete} users not yet observable` : `${cell.retained}/${cell.eligible} retained`}
                >
                  {cell.rate === null ? <span className="text-xs text-muted">pending</span> : fmtPct(cell.rate)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

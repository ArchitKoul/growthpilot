"use client";

import { CATEGORIES, CHANNELS, PLATFORMS } from "@/lib/analytics/schema";
import { resolveRange, type DateRange } from "@/lib/analytics/core";
import { DEFAULT_FILTERS, useData, type Filters } from "./data-context";
import { Button, Select, label } from "./ui";

const PRESETS = [
  ["last_7_days", "Last 7 days"],
  ["last_14_days", "Last 14 days"],
  ["last_30_days", "Last 30 days"],
  ["last_90_days", "Last 90 days"],
  ["all", "All time"],
] as const;

export function FilterBar({ showCategory = true, showSegments = true }: { showCategory?: boolean; showSegments?: boolean }) {
  const { filters, setFilters, prepared } = useData();
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const isCustom = !("preset" in filters.range);
  const resolved = prepared ? resolveRange(filters.range, prepared) : null;

  const onRange = (v: string) => {
    if (v === "custom" && prepared) {
      const r = resolveRange({ preset: "last_30_days" }, prepared);
      set({ range: { start: new Date(r.start).toISOString().slice(0, 10), end: new Date(r.end - 86_400_000).toISOString().slice(0, 10) } });
    } else set({ range: { preset: v as Extract<DateRange, { preset: string }>["preset"] } });
  };

  return (
    <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <Select label="Date range" value={isCustom ? "custom" : (filters.range as { preset: string }).preset} onChange={(e) => onRange(e.target.value)}>
        {PRESETS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </Select>
      {isCustom && "start" in filters.range && (
        <>
          <label className="flex flex-col gap-1 text-xs text-muted">
            From
            <input type="date" className="rounded-lg border border-line px-2 py-1.5 text-sm text-ink" value={filters.range.start}
              onChange={(e) => e.target.value && set({ range: { ...(filters.range as { start: string; end: string }), start: e.target.value } })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            To
            <input type="date" className="rounded-lg border border-line px-2 py-1.5 text-sm text-ink" value={filters.range.end}
              onChange={(e) => e.target.value && set({ range: { ...(filters.range as { start: string; end: string }), end: e.target.value } })} />
          </label>
        </>
      )}
      {showSegments && (
        <>
          <Select label="Platform" value={filters.platform} onChange={(e) => set({ platform: e.target.value as Filters["platform"] })}>
            <option value="all">All platforms</option>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p === "ios" ? "iOS" : p[0].toUpperCase() + p.slice(1)}</option>)}
          </Select>
          <Select label="Acquisition" value={filters.channel} onChange={(e) => set({ channel: e.target.value as Filters["channel"] })}>
            <option value="all">All channels</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Select>
          {showCategory && (
            <Select label="Course category" value={filters.category} onChange={(e) => set({ category: e.target.value as Filters["category"] })}>
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
            </Select>
          )}
        </>
      )}
      <Button variant="ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset</Button>
      {resolved && <div className="ml-auto text-xs text-muted">{resolved.label} (UTC)</div>}
    </div>
  );
}

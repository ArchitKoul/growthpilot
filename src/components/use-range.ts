"use client";

import { useMemo } from "react";
import { resolveRange, type ResolvedRange } from "@/lib/analytics/core";
import { useData } from "./data-context";

/** Resolve the global date filter against the active dataset; surfaces invalid custom ranges. */
export function useRange(): { range: ResolvedRange | null; error: string | null } {
  const { filters, prepared } = useData();
  return useMemo(() => {
    if (!prepared) return { range: null, error: null };
    try {
      return { range: resolveRange(filters.range, prepared), error: null };
    } catch (e) {
      return { range: null, error: e instanceof Error ? e.message : "Invalid date range" };
    }
  }, [filters.range, prepared]);
}

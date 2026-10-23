"use client";

import { useMemo } from "react";
import { useData } from "./data-context";
import type { Experiment } from "@/lib/analytics/experiments";
import type { InvestigationResult } from "@/lib/agent/report";

export interface ExperimentEntry {
  exp: Experiment;
  investigation: InvestigationResult;
}

/** Experiments produced by past investigations (newest first, de-duplicated per dataset). */
export function useExperiments(): ExperimentEntry[] {
  const { investigations } = useData();
  return useMemo(() => {
    const seen = new Set<string>();
    const out: ExperimentEntry[] = [];
    for (const inv of investigations)
      for (const exp of inv.report.experiments) {
        const key = `${inv.dataset.id}:${exp.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ exp, investigation: inv });
      }
    return out;
  }, [investigations]);
}

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Category, Channel, Dataset, Platform } from "@/lib/analytics/schema";
import { prepare, type DateRange, type PreparedData, type SegmentFilter } from "@/lib/analytics/core";
import { getSyntheticDataset, SYNTHETIC_DATASET_ID } from "@/lib/analytics/synthetic";
import type { InvestigationResult } from "@/lib/agent/report";

export interface Filters {
  range: DateRange;
  platform: Platform | "all";
  channel: Channel | "all";
  category: Category | "all";
}

export interface Status {
  liveAvailable: boolean;
  model: string | null;
  persistence: "supabase" | "browser";
}

interface Ctx {
  datasets: Dataset[];
  active: Dataset | null;
  prepared: PreparedData | null;
  setActiveId: (id: string) => void;
  addDataset: (d: Dataset) => void;
  removeDataset: (id: string) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  segmentFilter: SegmentFilter | undefined;
  investigations: InvestigationResult[];
  addInvestigation: (r: InvestigationResult) => void;
  clearInvestigations: () => void;
  status: Status | null;
  datasetRef: () => unknown;
}

const DataCtx = createContext<Ctx | null>(null);
const HISTORY_KEY = "growthpilot.investigations.v1";
const MAX_HISTORY = 15;

export const DEFAULT_FILTERS: Filters = { range: { preset: "last_90_days" }, platform: "all", channel: "all", category: "all" };

function loadHistory(): InvestigationResult[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as InvestigationResult[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: InvestigationResult[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    // storage full or blocked: history is a convenience, keep going
  }
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeId, setActiveId] = useState<string>(SYNTHETIC_DATASET_ID);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [investigations, setInvestigations] = useState<InvestigationResult[]>([]);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    // generate the deterministic demo dataset after first paint
    const t = setTimeout(() => {
      setDatasets((d) => (d.some((x) => x.meta.id === SYNTHETIC_DATASET_ID) ? d : [getSyntheticDataset(), ...d]));
      setInvestigations(loadHistory());
    }, 0);
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ liveAvailable: false, model: null, persistence: "browser" }));
    return () => clearTimeout(t);
  }, []);

  const active = datasets.find((d) => d.meta.id === activeId) ?? null;
  const prepared = useMemo(() => (active ? prepare(active.events) : null), [active]);

  const segmentFilter = useMemo<SegmentFilter | undefined>(() => {
    const f: SegmentFilter = {};
    if (filters.platform !== "all") f.platform = [filters.platform];
    if (filters.channel !== "all") f.acquisition_channel = [filters.channel];
    if (filters.category !== "all") f.course_category = [filters.category];
    return Object.keys(f).length ? f : undefined;
  }, [filters]);

  const addDataset = useCallback((d: Dataset) => {
    setDatasets((cur) => [...cur.filter((x) => x.meta.id !== d.meta.id), d]);
    setActiveId(d.meta.id);
    setFilters({ ...DEFAULT_FILTERS, range: { preset: "all" } });
  }, []);

  const removeDataset = useCallback(
    (id: string) => {
      if (id === SYNTHETIC_DATASET_ID) return;
      setDatasets((cur) => cur.filter((x) => x.meta.id !== id));
      if (activeId === id) setActiveId(SYNTHETIC_DATASET_ID);
    },
    [activeId],
  );

  const addInvestigation = useCallback((r: InvestigationResult) => {
    setInvestigations((cur) => {
      const next = [r, ...cur.filter((x) => x.id !== r.id)].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearInvestigations = useCallback(() => {
    setInvestigations([]);
    saveHistory([]);
  }, []);

  const datasetRef = useCallback(() => {
    if (!active || active.meta.source === "synthetic") return { kind: "synthetic", id: SYNTHETIC_DATASET_ID };
    return { kind: "upload", meta: active.meta, events: active.events };
  }, [active]);

  const value: Ctx = {
    datasets,
    active,
    prepared,
    setActiveId,
    addDataset,
    removeDataset,
    filters,
    setFilters,
    segmentFilter,
    investigations,
    addInvestigation,
    clearInvestigations,
    status,
    datasetRef,
  };
  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}

export function useData(): Ctx {
  const c = useContext(DataCtx);
  if (!c) throw new Error("useData must be used inside DataProvider");
  return c;
}

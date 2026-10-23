"use client";

import { useEffect, useState } from "react";
import { useData } from "@/components/data-context";
import { ReportView } from "@/components/report-view";
import { Badge, Button, Card, Empty, Notice, PageHeader, cx, label } from "@/components/ui";
import type { InvestigationResult } from "@/lib/agent/report";

const EXAMPLES = [
  "Investigate why course purchase conversion declined over the last seven days. Compare user segments, inspect the funnel, validate the data, and recommend experiments.",
  "Where is the biggest funnel drop-off?",
  "Why is Day 30 retention low?",
  "Which user segments convert best?",
  "What experiment should we run to improve retention?",
];

const PROGRESS = ["Validating dataset…", "Selecting analytical tools…", "Running calculations…", "Checking evidence…", "Writing report…"];

export default function InvestigatePage() {
  const { active, status, datasetRef, investigations, addInvestigation, clearInvestigations } = useData();
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<"auto" | "demo">("auto");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // selected investigation id; initialised from ?id= so links from other pages open it
  const [currentId, setCurrentId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("id"),
  );
  const current = investigations.find((r) => r.id === currentId) ?? null;
  const setCurrent = (r: InvestigationResult) => setCurrentId(r.id);

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setProgress((p) => Math.min(p + 1, PROGRESS.length - 1)), 1800);
    return () => clearInterval(t);
  }, [loading]);

  const live = status?.liveAvailable && mode === "auto";

  async function run(q: string) {
    if (!active || q.trim().length < 3) return;
    setLoading(true);
    setProgress(0);
    setError(null);
    try {
      const res = await fetch("/api/investigate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q.trim(), mode, dataset: datasetRef() }),
      });
      const body = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      const r = body.result as InvestigationResult;
      setCurrent(r);
      addInvestigation(r);
      window.history.replaceState(null, "", `/investigate?id=${r.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Investigation failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Investigation workspace"
        description="Ask an analytical question. The agent chooses validated analytical tools, runs them on the active dataset, and writes an evidence-backed report."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(question);
              }}
            >
              <label htmlFor="q" className="text-sm font-medium text-ink">Question</label>
              <textarea
                id="q"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(question);
                }}
                rows={3}
                maxLength={1000}
                placeholder="e.g. Why has purchase conversion declined over the last 7 days?"
                className="mt-1.5 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button type="button" key={ex} onClick={() => setQuestion(ex)} className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-2 hover:border-accent hover:text-ink">
                    {ex.length > 60 ? ex.slice(0, 58) + "…" : ex}
                  </button>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  <span>Engine:</span>
                  <div className="inline-flex rounded-lg border border-line p-0.5">
                    {(["auto", "demo"] as const).map((m) => (
                      <button
                        type="button"
                        key={m}
                        onClick={() => setMode(m)}
                        className={cx("rounded-md px-2.5 py-1", mode === m ? "bg-surface-2 font-medium text-ink" : "text-muted")}
                      >
                        {m === "auto" ? (status?.liveAvailable ? "Claude (live)" : "Claude (not configured)") : "Demo planner"}
                      </button>
                    ))}
                  </div>
                  <span className="text-muted">Dataset: {active?.meta.name ?? "loading…"}</span>
                </div>
                <Button type="submit" variant="primary" disabled={loading || !active || question.trim().length < 3}>
                  {loading ? "Investigating…" : "Investigate"}
                </Button>
              </div>
              {mode === "auto" && status && !status.liveAvailable && (
                <p className="mt-3 text-xs text-warn">
                  No ANTHROPIC_API_KEY is configured on the server, so this will run in demo mode: a rule-based planner calls the same analytical tools, but no LLM is used.
                </p>
              )}
            </form>
          </Card>

          {error && <Notice tone="bad">{error}</Notice>}
          {loading && (
            <Card>
              <div className="flex items-center gap-3 text-sm text-ink-2" role="status">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
                {live ? PROGRESS[progress] : "Running analytical tools…"}
              </div>
              {live && <p className="mt-2 text-xs text-muted">Live investigations usually take 20–90 seconds.</p>}
            </Card>
          )}
          {!loading && current && (
            <div>
              <div className="mb-3 text-sm text-ink-2">
                <span className="text-muted">Question:</span> {current.question}
              </div>
              <ReportView result={current} />
            </div>
          )}
          {!loading && !current && !error && (
            <Empty title="No investigation selected">Pick an example or type a question to start. Past investigations appear on the right.</Empty>
          )}
        </div>

        <aside className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">History</h2>
            {investigations.length > 0 && (
              <button className="text-xs text-muted hover:text-bad" onClick={() => confirm("Clear investigation history in this browser?") && clearInvestigations()}>
                Clear
              </button>
            )}
          </div>
          {investigations.length === 0 ? (
            <p className="text-xs text-muted">Investigations are saved in this browser{status?.persistence === "supabase" ? " and in Supabase" : ""}.</p>
          ) : (
            <ul className="space-y-1.5">
              {investigations.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => {
                      setCurrent(r);
                      window.history.replaceState(null, "", `/investigate?id=${r.id}`);
                    }}
                    className={cx("w-full rounded-lg border px-3 py-2 text-left", current?.id === r.id ? "border-accent bg-accent-soft/40" : "border-line bg-surface hover:bg-surface-2")}
                  >
                    <div className="line-clamp-2 text-xs text-ink">{r.question}</div>
                    <div className="mt-1 flex gap-1">
                      <Badge tone={r.mode === "live" ? "good" : "warn"}>{r.mode}</Badge>
                      <Badge>{label(r.report.answer_status)}</Badge>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}

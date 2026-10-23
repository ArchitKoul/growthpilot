"use client";

import Link from "next/link";
import { useState } from "react";
import type { InvestigationResult, ToolStep } from "@/lib/agent/report";
import { ExperimentCard } from "./experiment-card";
import { Badge, Card, Notice, cx, label } from "./ui";

const STATUS_TONE = { answered: "good", partially_answered: "warn", insufficient_evidence: "warn", unsupported: "neutral" } as const;

function StepItem({ step, highlight }: { step: ToolStep; highlight: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li id={`step-${step.id}`} className={cx("rounded-lg border px-3 py-2", highlight ? "border-accent bg-accent-soft/40" : "border-line")}>
      <button className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs text-muted">{step.id}</span>
          <span className="font-medium text-ink">{step.tool}</span>
          <Badge tone={step.status === "ok" ? "good" : "bad"}>{step.status === "ok" ? "ok" : "rejected"}</Badge>
        </span>
        <span className="text-xs text-muted">
          {step.duration_ms} ms · {open ? "hide" : "show"} I/O
        </span>
      </button>
      {step.error && <p className="mt-1 text-xs text-bad">{step.error}</p>}
      {open && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Input</div>
            <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-2 text-[11px] leading-relaxed">{JSON.stringify(step.input, null, 2)}</pre>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Output</div>
            <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-2 text-[11px] leading-relaxed">
              {step.output !== undefined ? JSON.stringify(step.output, null, 2) : "—"}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

export function ReportView({ result }: { result: InvestigationResult }) {
  const r = result.report;
  const [focus, setFocus] = useState<string | null>(null);
  const g = r.grounding;
  const groundingOk = g.unverified_numbers.length === 0 && g.invalid_evidence_refs.length === 0 && g.unsupported_findings.length === 0;

  const jump = (id: string) => {
    setFocus(id);
    document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={result.mode === "live" ? "good" : "warn"}>{result.mode === "live" ? `Live AI · ${result.model}` : "Demo mode · rule-based planner (no LLM)"}</Badge>
        <Badge tone={STATUS_TONE[r.answer_status]}>{label(r.answer_status)}</Badge>
        <span>Dataset: <span className="text-ink-2">{result.dataset.name}</span> ({result.dataset.id})</span>
        <span>· {result.steps.length} tool calls · {(result.duration_ms / 1000).toFixed(1)} s</span>
      </div>

      {result.error && <Notice tone="bad">{result.error}</Notice>}

      <Card title="Summary">
        <p className="text-[15px] leading-relaxed text-ink">{r.summary}</p>
      </Card>

      {r.findings.length > 0 && (
        <Card title="Findings" subtitle="Supported = shown directly by tool results with adequate sample; hypothesis = plausible but unverified">
          <ul className="space-y-3">
            {r.findings.map((f, i) => (
              <li key={i} className="rounded-lg border border-line p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={f.type === "supported" ? "good" : "warn"}>{f.type}</Badge>
                  <Badge>{f.confidence} confidence</Badge>
                  <h3 className="text-sm font-semibold text-ink">{f.title}</h3>
                </div>
                <p className="mt-1.5 text-sm text-ink-2">{f.statement}</p>
                {f.evidence.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {f.evidence.map((e, j) => (
                      <button key={j} onClick={() => jump(e.tool_call_id)} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-left text-xs text-ink-2 hover:border-accent" title="Show tool call">
                        <span className="font-mono text-accent">{e.tool_call_id}</span> {e.detail}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {r.experiments.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recommended experiments</h2>
            <Link href="/experiments" className="text-xs text-accent">All experiments & briefs →</Link>
          </div>
          {r.experiments.map((e) => <ExperimentCard key={e.id} exp={e} compact />)}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Limitations & data quality">
          {r.limitations.length ? (
            <ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">{r.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
          ) : (
            <p className="text-sm text-muted">None reported.</p>
          )}
          {r.next_steps.length > 0 && (
            <>
              <div className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">Next steps</div>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-ink-2">{r.next_steps.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </>
          )}
        </Card>
        <Card title="Evidence check" subtitle="Automatic check that report numbers come from tool outputs">
          <Notice tone={groundingOk ? "good" : "warn"}>
            {groundingOk
              ? `All ${g.checked_numbers} numbers in the report match tool outputs, and every supported finding cites a successful tool call.`
              : "Some claims could not be verified against tool outputs — treat them with caution."}
          </Notice>
          {g.unverified_numbers.length > 0 && <p className="mt-2 text-xs text-warn">Unverified numbers: {g.unverified_numbers.join(", ")}</p>}
          {g.invalid_evidence_refs.length > 0 && <p className="mt-1 text-xs text-warn">Invalid evidence references: {g.invalid_evidence_refs.join(", ")}</p>}
          {g.unsupported_findings.length > 0 && <p className="mt-1 text-xs text-warn">Supported findings without evidence: {g.unsupported_findings.join("; ")}</p>}
        </Card>
      </div>

      <Card title="Investigation log" subtitle="The analytical steps actually executed, with their real inputs and outputs">
        {result.activity.length > 0 && (
          <ol className="mb-4 space-y-1 border-l-2 border-line pl-3 text-sm text-ink-2">
            {result.activity.map((a, i) => <li key={i}>{a}</li>)}
          </ol>
        )}
        {result.steps.length ? (
          <ul className="space-y-2">{result.steps.map((s) => <StepItem key={s.id} step={s} highlight={focus === s.id} />)}</ul>
        ) : (
          <p className="text-sm text-muted">No tools were executed for this question.</p>
        )}
      </Card>
    </div>
  );
}

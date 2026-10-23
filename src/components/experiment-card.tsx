"use client";

import type { Experiment } from "@/lib/analytics/experiments";
import { Badge, fmtNum, fmtPct } from "./ui";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[170px_1fr] sm:gap-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{k}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

export function ExperimentCard({ exp, compact }: { exp: Experiment; compact?: boolean }) {
  const d = exp.design;
  return (
    <article className="rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-3.5">
        <h3 className="text-sm font-semibold text-ink">{exp.title}</h3>
        <div className="flex gap-1.5">
          <Badge tone="accent">{exp.target_segment}</Badge>
          <Badge>{exp.primary_metric}</Badge>
        </div>
      </header>
      <dl className="divide-y divide-line px-5">
        <Row k="Problem">{exp.problem_statement}</Row>
        <Row k="Hypothesis">{exp.hypothesis}</Row>
        <Row k="Proposed change">{exp.proposed_change}</Row>
        {!compact && (
          <>
            <Row k="Evidence">
              <ul className="list-disc space-y-0.5 pl-4">{exp.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </Row>
            <Row k="Primary metric">{exp.primary_metric}</Row>
            <Row k="Guardrails">{exp.guardrail_metrics.join(" · ")}</Row>
          </>
        )}
        <Row k="Design">
          {d.type}; unit {d.randomization_unit}; {d.allocation}. Baseline {fmtPct(d.baseline_rate)}, MDE +{fmtPct(d.minimum_detectable_effect)} absolute →{" "}
          <strong>{fmtNum(d.sample_size_per_arm)}</strong> users/arm
          {d.estimated_duration_days ? <> (~{d.estimated_duration_days} days at current traffic)</> : null}.
          {!compact && <div className="mt-1 text-xs text-ink-2">{d.analysis}</div>}
        </Row>
        {!compact && (
          <>
            <Row k="Supports hypothesis if">{exp.support_conditions}</Row>
            <Row k="Rejects hypothesis if">{exp.reject_conditions}</Row>
            <Row k="Risks & limitations">
              <ul className="list-disc space-y-0.5 pl-4">{exp.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </Row>
            <Row k="Before launching">
              <ul className="list-disc space-y-0.5 pl-4">{exp.pre_experiment_actions.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </Row>
          </>
        )}
        <Row k="Causality">
          <span className="text-ink-2">{exp.causal_caveat}</span>
        </Row>
      </dl>
    </article>
  );
}

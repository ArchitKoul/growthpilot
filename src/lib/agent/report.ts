import { z } from "zod";
import type { Experiment } from "../analytics/experiments";

export const ANSWER_STATUSES = ["answered", "partially_answered", "insufficient_evidence", "unsupported"] as const;

/** What the model submits via submit_report (validated server-side). */
export const SubmittedReportSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    answer_status: z.enum(ANSWER_STATUSES),
    findings: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            statement: z.string().min(1).max(1500),
            type: z.enum(["supported", "hypothesis"]),
            confidence: z.enum(["high", "medium", "low"]),
            evidence: z
              .array(z.object({ tool_call_id: z.string().min(1).max(20), detail: z.string().min(1).max(500) }).strict())
              .max(8),
          })
          .strict(),
      )
      .max(10),
    limitations: z.array(z.string().min(1).max(500)).max(10),
    next_steps: z.array(z.string().min(1).max(500)).max(8),
  })
  .strict();
export type SubmittedReport = z.infer<typeof SubmittedReportSchema>;

export interface ToolStep {
  id: string; // T1, T2, …
  tool: string;
  input: unknown;
  status: "ok" | "error";
  output?: unknown;
  error?: string;
  duration_ms: number;
}

export interface GroundingResult {
  checked_numbers: number;
  unverified_numbers: string[];
  invalid_evidence_refs: string[];
  /** findings typed "supported" that cite no successful tool call */
  unsupported_findings: string[];
}

export interface InvestigationReport extends SubmittedReport {
  experiments: Experiment[];
  grounding: GroundingResult;
}

export interface InvestigationResult {
  id: string;
  question: string;
  mode: "demo" | "live";
  model: string | null;
  dataset: { id: string; name: string; source: string; rows: number };
  started_at: string;
  duration_ms: number;
  steps: ToolStep[];
  /** concise, user-facing notes on what the agent did (not chain-of-thought) */
  activity: string[];
  report: InvestigationReport;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Grounding check                                                     */
/* ------------------------------------------------------------------ */

function collectNumbers(v: unknown, out: number[]) {
  if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectNumbers(x, out));
}

/** Numbers that need no tool support: small integers (day counts, list positions) and date parts. */
function isExempt(raw: string, n: number): boolean {
  return Number.isInteger(n) && !raw.includes(".") && !raw.endsWith("%") && n <= 31;
}

/**
 * Verify that every number quoted in the report appears in (or is a
 * percentage/rounding of) a value returned by a successful tool call, and that
 * every evidence reference points at a real successful tool call.
 */
export function checkGrounding(report: SubmittedReport, steps: ToolStep[], extraTexts: string[] = []): GroundingResult {
  const okSteps = new Map(steps.filter((s) => s.status === "ok").map((s) => [s.id, s]));
  const pool: number[] = [];
  for (const s of okSteps.values()) collectNumbers(s.output, pool);
  // also allow differences of numbers in the same call output (e.g. "fell 31.5 points")
  const values = new Set<number>();
  for (const s of okSteps.values()) {
    const nums: number[] = [];
    collectNumbers(s.output, nums);
    const rates = nums.filter((n) => n > 0 && n < 1);
    for (let i = 0; i < rates.length && i < 400; i++)
      for (let j = i + 1; j < rates.length && j < 400; j++) values.add(Math.abs(rates[i] - rates[j]));
  }
  for (const n of pool) values.add(n);

  const texts = [
    report.summary,
    ...report.findings.flatMap((f) => [f.title, f.statement, ...f.evidence.map((e) => e.detail)]),
    ...extraTexts,
  ];
  const unverified: string[] = [];
  let checked = 0;
  const re = /(?<![\w.-])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s?%|\s?pp|\s?points)?/g;
  const vals = [...values];
  for (const t of texts) {
    const clean = t.replace(/p\s*[<=]\s*0\.0*1\b/g, " ").replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\b[TDd]\d+\b/g, " ");
    for (const m of clean.matchAll(re)) {
      const raw = m[0].trim();
      const n = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(n) || isExempt(raw, n)) continue;
      checked++;
      const isPct = /%|pp|points/.test(m[2] ?? "");
      const decimals = (m[1].split(".")[1] ?? "").length;
      const tol = 0.5 * 10 ** -decimals + 1e-9;
      const ok = vals.some((v) => {
        if (Math.abs(v - n) <= tol) return true;
        if (Math.abs(v * 100 - n) <= tol) return true;
        return !isPct && Math.abs(v * 100 - n) <= tol;
      });
      if (!ok) unverified.push(raw);
    }
  }

  const invalidRefs: string[] = [];
  const unsupported: string[] = [];
  for (const f of report.findings) {
    const refs = f.evidence.map((e) => e.tool_call_id);
    for (const r of refs) if (!okSteps.has(r)) invalidRefs.push(r);
    if (f.type === "supported" && !refs.some((r) => okSteps.has(r))) unsupported.push(f.title);
  }
  return { checked_numbers: checked, unverified_numbers: [...new Set(unverified)], invalid_evidence_refs: [...new Set(invalidRefs)], unsupported_findings: unsupported };
}

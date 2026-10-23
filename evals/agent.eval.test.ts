/**
 * Agent-level evaluation scenarios. These run the demo investigator (same tools
 * as the live agent, deterministic planner) and score tool selection, grounding,
 * uncertainty handling and experiment structure. Results are written to
 * docs/EVAL_RESULTS.md from the ACTUAL run — nothing is hard-coded.
 */
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getSyntheticDataset, generateSyntheticEvents } from "@/lib/analytics/synthetic";
import type { Dataset } from "@/lib/analytics/schema";
import { runDemoInvestigation } from "@/lib/agent/demo";
import { executeTool } from "@/lib/agent/tools";
import { prepare } from "@/lib/analytics/core";
import type { InvestigationResult } from "@/lib/agent/report";

const synthetic = getSyntheticDataset();
const makeDataset = (id: string, events: Dataset["events"]): Dataset => ({
  meta: { id, name: id, source: "upload", createdAt: "2026-10-20T00:00:00Z", rowCount: events.length },
  events,
});
const noRegression = makeDataset("no-regression", generateSyntheticEvents({ injectAndroidPaymentRegression: false, seed: 7 }));
const tiny = makeDataset("tiny", generateSyntheticEvents({ days: 10, usersPerDay: 2, seed: 3 }));

interface Scenario {
  id: string;
  category: string;
  question: string;
  dataset: Dataset;
  expectTools: string[];
  forbidTools?: string[];
  expectStatus: InvestigationResult["report"]["answer_status"][];
  expectExperiment: boolean;
  check?: (r: InvestigationResult) => void;
}

const SCENARIOS: Scenario[] = [
  {
    id: "A01",
    category: "conversion decline (planted)",
    question:
      "Investigate why course purchase conversion declined over the last seven days. Compare user segments, inspect the funnel, validate the data, and recommend experiments.",
    dataset: synthetic,
    expectTools: ["validate_event_data", "get_metric_trend", "analyze_funnel", "compare_segments", "generate_experiment"],
    expectStatus: ["answered"],
    expectExperiment: true,
    check: (r) => {
      const supported = r.report.findings.filter((f) => f.type === "supported").map((f) => f.statement).join(" ");
      expect(supported).toMatch(/android/);
      expect(supported).toMatch(/payment_initiated → purchase_completed/);
      expect(r.report.findings.some((f) => f.type === "hypothesis" && /defect/.test(f.title))).toBe(true);
      expect(r.report.experiments[0].target_segment).toBe("platform = android");
    },
  },
  {
    id: "A02",
    category: "retention",
    question: "Why is Day 30 retention low?",
    dataset: synthetic,
    expectTools: ["calculate_cohort_retention", "compare_segments"],
    expectStatus: ["answered"],
    expectExperiment: true,
    check: (r) => {
      expect(r.report.summary).toMatch(/excluded rather than counted as churned/);
      expect(r.report.limitations.join(" ")).toMatch(/self-selected/);
    },
  },
  {
    id: "A03",
    category: "funnel drop-off",
    question: "Where is the biggest funnel drop-off?",
    dataset: synthetic,
    expectTools: ["analyze_funnel"],
    expectStatus: ["answered"],
    expectExperiment: true,
    check: (r) => expect(r.report.findings[0].title).toMatch(/Biggest drop-off/),
  },
  {
    id: "A04",
    category: "segments",
    question: "Which user segments convert best?",
    dataset: synthetic,
    expectTools: ["compare_segments"],
    forbidTools: ["generate_experiment"],
    expectStatus: ["answered"],
    expectExperiment: false,
    check: (r) => expect(r.steps.filter((s) => s.tool === "compare_segments")).toHaveLength(4),
  },
  {
    id: "A05",
    category: "experiment request",
    question: "What experiment should we run to improve retention?",
    dataset: synthetic,
    expectTools: ["calculate_cohort_retention", "generate_experiment"],
    expectStatus: ["answered"],
    expectExperiment: true,
  },
  {
    id: "A06",
    category: "unsupported question",
    question: "What will the AAPL stock price be tomorrow? Should I buy?",
    dataset: synthetic,
    expectTools: [],
    forbidTools: ["get_metric_trend", "analyze_funnel", "compare_segments", "generate_experiment"],
    expectStatus: ["unsupported"],
    expectExperiment: false,
    check: (r) => expect(r.steps).toHaveLength(0),
  },
  {
    id: "A07",
    category: "insufficient evidence (data not available)",
    question: "How has our NPS changed after the new onboarding?",
    dataset: synthetic,
    expectTools: ["validate_event_data"],
    forbidTools: ["generate_experiment"],
    expectStatus: ["insufficient_evidence"],
    expectExperiment: false,
  },
  {
    id: "A08",
    category: "missing & duplicate events",
    question: "Check the data quality: are there duplicate or missing events?",
    dataset: synthetic,
    expectTools: ["validate_event_data"],
    expectStatus: ["answered"],
    expectExperiment: false,
    check: (r) => {
      const q = r.steps[0].output as { checks: { id: string; count: number }[] };
      expect(q.checks.find((c) => c.id === "duplicates")!.count).toBeGreaterThan(0);
      expect(q.checks.find((c) => c.id === "missing_session_id")!.count).toBeGreaterThan(0);
    },
  },
  {
    id: "A09",
    category: "conflicting premise (no real decline)",
    question: "Why did purchase conversion decline over the last 7 days?",
    dataset: noRegression,
    expectTools: ["get_metric_trend", "analyze_funnel", "compare_segments"],
    expectStatus: ["insufficient_evidence", "answered"],
    expectExperiment: false,
    check: (r) => {
      const trend = r.report.findings.find((f) => /Purchase conversion/.test(f.title))!;
      // must not assert a significant decline that the data does not show
      if (trend.type === "supported") expect(trend.title).toBe("Purchase conversion declined");
      else expect(r.report.summary).toMatch(/not statistically significant|not established/);
      expect(r.report.findings.some((f) => /defect/.test(f.title))).toBe(false);
    },
  },
  {
    id: "A10",
    category: "small sample",
    question: "Why did purchase conversion decline over the last 7 days?",
    dataset: tiny,
    expectTools: ["get_metric_trend"],
    expectStatus: ["insufficient_evidence"],
    expectExperiment: false,
    check: (r) => expect(r.report.findings.filter((f) => f.type === "supported")).toHaveLength(0),
  },
  {
    id: "A11",
    category: "segment-scoped question",
    question: "Why did iOS purchase conversion decline in the last 7 days?",
    dataset: synthetic,
    expectTools: ["get_metric_trend", "analyze_funnel"],
    expectStatus: ["insufficient_evidence", "answered"],
    expectExperiment: false,
    check: (r) => {
      const trendInput = r.steps.find((s) => s.tool === "get_metric_trend")!.input as { segments?: { platform?: string[] } };
      expect(trendInput.segments?.platform).toEqual(["ios"]);
      expect(r.report.findings.some((f) => f.type === "supported" && /android/.test(f.statement))).toBe(false);
    },
  },
  {
    id: "A12",
    category: "zero denominators (empty segment range)",
    question: "Where is the biggest funnel drop-off for web users in the last 7 days?",
    dataset: makeDataset("ios-only", generateSyntheticEvents({ days: 20, usersPerDay: 10, seed: 9 }).filter((e) => e.platform !== "web")),
    expectTools: ["analyze_funnel"],
    expectStatus: ["insufficient_evidence"],
    expectExperiment: false,
    check: (r) => expect(r.report.summary).toMatch(/no entrants/),
  },
];

interface Row {
  id: string;
  category: string;
  toolSelection: boolean;
  statusOk: boolean;
  experimentOk: boolean;
  checkOk: boolean;
  numbersChecked: number;
  unverified: number;
  supportedFindings: number;
  unsupportedFindings: number;
  tools: string;
  status: string;
}
const rows: Row[] = [];

describe("agent evaluation scenarios (demo planner, real tools)", () => {
  for (const sc of SCENARIOS) {
    it(`${sc.id} ${sc.category}`, () => {
      const r = runDemoInvestigation(sc.question, sc.dataset, prepare(sc.dataset.events));
      const used = new Set(r.steps.map((s) => s.tool));
      const toolSelection = sc.expectTools.every((t) => used.has(t)) && !(sc.forbidTools ?? []).some((t) => used.has(t));
      const statusOk = sc.expectStatus.includes(r.report.answer_status);
      const experimentOk =
        sc.expectExperiment === r.report.experiments.length > 0 &&
        r.report.experiments.every(
          (e) => e.hypothesis && e.primary_metric && e.guardrail_metrics.length > 0 && e.support_conditions && e.reject_conditions && e.causal_caveat && e.design.sample_size_per_arm !== null,
        );
      let checkOk = true;
      try {
        sc.check?.(r);
      } catch {
        checkOk = false;
      }
      const g = r.report.grounding;
      rows.push({
        id: sc.id,
        category: sc.category,
        toolSelection,
        statusOk,
        experimentOk,
        checkOk,
        numbersChecked: g.checked_numbers,
        unverified: g.unverified_numbers.length,
        supportedFindings: r.report.findings.filter((f) => f.type === "supported").length,
        unsupportedFindings: g.unsupported_findings.length + g.invalid_evidence_refs.length,
        tools: r.steps.map((s) => s.tool).join(", ") || "—",
        status: r.report.answer_status,
      });
      expect(r.steps.every((s) => s.status === "ok")).toBe(true);
      expect({ toolSelection, statusOk, experimentOk, checkOk }).toEqual({ toolSelection: true, statusOk: true, experimentOk: true, checkOk: true });
      expect(g.unverified_numbers).toEqual([]);
      sc.check?.(r);
    });
  }
});

describe("tool guardrails", () => {
  const ctx = { dataset: synthetic, data: prepare(synthetic.events) };
  it("G01 rejects unknown / unapproved tools", () => {
    expect(executeTool("run_sql", { query: "DROP TABLE users" }, ctx)).toMatchObject({ ok: false });
    expect(executeTool("eval", "process.exit()", ctx)).toMatchObject({ ok: false });
  });
  it("G02 rejects malformed tool inputs with a clear message", () => {
    const r = executeTool("get_metric_trend", { metric: "happiness", date_range: { preset: "yesterday" } }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid input/);
    expect(executeTool("analyze_funnel", { date_range: { preset: "all" }, event_sequence: ["registration", "registration"] }, ctx).ok).toBe(false);
    expect(executeTool("analyze_funnel", { date_range: { preset: "all" }, extra: 1 }, ctx).ok).toBe(false);
  });
  it("G03 refuses to validate a different dataset (never combines datasets)", () => {
    const r = executeTool("validate_event_data", { dataset_id: "some-other-dataset" }, ctx);
    expect(r).toMatchObject({ ok: false });
  });
  it("G04 rejects experiment findings with out-of-range numbers", () => {
    const r = executeTool(
      "generate_experiment",
      { finding: { title: "x x", statement: "y y y", metric: "purchase_conversion", baseline_rate: 7, sample_size: 10, evidence: ["T1"] }, target_metric: "pc" },
      ctx,
    );
    expect(r.ok).toBe(false);
  });
});

afterAll(() => {
  if (rows.length === 0) return;
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const n = rows.length;
  const rate = (k: keyof Row) => rows.filter((r) => r[k] === true).length;
  const numbers = rows.reduce((s, r) => s + r.numbersChecked, 0);
  const unverified = rows.reduce((s, r) => s + r.unverified, 0);
  const supported = rows.reduce((s, r) => s + r.supportedFindings, 0);
  const unsupported = rows.reduce((s, r) => s + r.unsupportedFindings, 0);
  const summary = {
    generated_at: new Date().toISOString(),
    mode: "demo (deterministic planner; live Claude agent not evaluated in this run)",
    scenarios: n,
    tool_selection_success: `${rate("toolSelection")}/${n}`,
    uncertainty_handling: `${rate("statusOk")}/${n}`,
    experiment_structure: `${rate("experimentOk")}/${n}`,
    scenario_assertions: `${rate("checkOk")}/${n}`,
    numbers_checked: numbers,
    unverified_numbers: unverified,
    unsupported_claim_rate: numbers ? `${((unverified / numbers) * 100).toFixed(2)}%` : "n/a",
    supported_findings: supported,
    findings_without_valid_evidence: unsupported,
  };
  const md = [
    "# Evaluation results",
    "",
    `Generated by \`npm run eval\` at ${summary.generated_at}. **This file is written by the test run itself** (see \`evals/agent.eval.test.ts\`).`,
    "",
    `Mode: ${summary.mode}.`,
    "",
    "| Metric | Result |",
    "|---|---|",
    `| Scenarios | ${n} |`,
    `| Tool-selection success | ${summary.tool_selection_success} |`,
    `| Uncertainty handling (correct answer_status) | ${summary.uncertainty_handling} |`,
    `| Experiment output structure | ${summary.experiment_structure} |`,
    `| Scenario-specific assertions | ${summary.scenario_assertions} |`,
    `| Numbers in reports checked against tool outputs | ${numbers} |`,
    `| Unverified numbers (unsupported-claim rate) | ${unverified} (${summary.unsupported_claim_rate}) |`,
    `| Supported findings without valid tool evidence | ${unsupported} of ${supported} |`,
    "",
    "| ID | Category | Status | Tools called | Tools ✓ | Status ✓ | Experiment ✓ | Checks ✓ | Unverified #s |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.category} | ${r.status} | ${r.tools} | ${r.toolSelection ? "✓" : "✗"} | ${r.statusOk ? "✓" : "✗"} | ${r.experimentOk ? "✓" : "✗"} | ${r.checkOk ? "✓" : "✗"} | ${r.unverified} |`,
    ),
    "",
    "Analytical accuracy is covered separately by `src/lib/analytics/__tests__/analytics.test.ts` (hand-computed expected values).",
    "",
  ].join("\n");
  const root = path.resolve(__dirname, "..");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "EVAL_RESULTS.md"), md);
  writeFileSync(path.join(root, "evals", "results.json"), JSON.stringify({ summary, rows }, null, 2));
});

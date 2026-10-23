import type { Experiment } from "./experiments";

export interface BriefContext {
  datasetName: string;
  datasetId: string;
  investigationQuestion?: string;
  generatedAt?: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Render a product brief (Markdown) from an experiment proposal. Pure function. */
export function generateBrief(exp: Experiment, ctx: BriefContext): string {
  const d = exp.design;
  const lines = [
    `# Product Brief: ${exp.title}`,
    "",
    `_Dataset: ${ctx.datasetName} (\`${ctx.datasetId}\`)${ctx.generatedAt ? ` · Generated ${ctx.generatedAt}` : ""}_`,
    "",
    "## 1. Context and user problem",
    exp.problem_statement,
    ...(ctx.investigationQuestion ? ["", `Originating question: “${ctx.investigationQuestion}”`] : []),
    "",
    "## 2. Supporting data",
    ...exp.evidence.map((e) => `- ${e}`),
    "",
    `> ${exp.causal_caveat}`,
    "",
    "## 3. Proposed solution",
    exp.proposed_change,
    "",
    `**Hypothesis.** ${exp.hypothesis}`,
    "",
    "## 4. Requirements",
    `- Target segment: **${exp.target_segment}**.`,
    `- Feature-flag the change; assign users by ${d.randomization_unit} with ${d.allocation} allocation.`,
    "- Instrument exposure events (`experiment_exposed`) with variant name for both arms.",
    "- Keep existing funnel events unchanged so baseline metrics remain comparable.",
    ...exp.pre_experiment_actions.map((a) => `- Before launch: ${a}`),
    "",
    "## 5. Acceptance criteria",
    "- [ ] Feature flag can enable/disable the change without a release.",
    "- [ ] Exposure is logged for 100% of assigned users in both arms (sample-ratio mismatch check passes).",
    `- [ ] ${exp.primary_metric} and all guardrails are visible on the experiment dashboard by day 1.`,
    "- [ ] QA verified on each affected platform.",
    "",
    "## 6. Success metrics",
    `- **Primary:** ${exp.primary_metric} — baseline ${pct(d.baseline_rate)}, minimum detectable effect +${pct(d.minimum_detectable_effect)} (absolute).`,
    `- **Sample size:** ${d.sample_size_per_arm ?? "n/a"} users per arm${d.estimated_duration_days ? `; estimated ${d.estimated_duration_days} days at current traffic` : ""}.`,
    `- **Guardrails:** ${exp.guardrail_metrics.join(", ")}.`,
    `- **Ship if:** ${exp.support_conditions}`,
    `- **Do not ship if:** ${exp.reject_conditions}`,
    "",
    "## 7. Dependencies and risks",
    "- Dependencies: experimentation/feature-flag service, analytics pipeline, design + engineering for the affected surface.",
    ...exp.risks.map((r) => `- Risk: ${r}`),
    "",
  ];
  return lines.join("\n");
}

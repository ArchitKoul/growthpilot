import { z } from "zod";
import { EVENT_NAMES } from "./schema";
import { SEGMENT_DIMENSIONS } from "./core";
import { sampleSizePerArm } from "./stats";

export const EXPERIMENT_TARGET_METRICS = [
  "purchase_conversion",
  "onboarding_rate",
  "funnel_conversion",
  "step_conversion",
  "d1_retention",
  "d7_retention",
  "d30_retention",
] as const;

export const FindingSchema = z
  .object({
    title: z.string().min(3).max(200),
    statement: z.string().min(3).max(1000),
    metric: z.enum(EXPERIMENT_TARGET_METRICS),
    segment: z
      .object({ dimension: z.enum(SEGMENT_DIMENSIONS), value: z.string().min(1).max(60) })
      .strict()
      .optional(),
    funnel_step: z.object({ from: z.enum(EVENT_NAMES), to: z.enum(EVENT_NAMES) }).strict().optional(),
    /** observed rate for the affected population (0..1) taken from a tool result */
    baseline_rate: z.number().min(0).max(1),
    /** comparison rate (previous period or other segments), if any */
    comparison_rate: z.number().min(0).max(1).optional(),
    /** users in the affected population over the analysed range */
    sample_size: z.number().int().nonnegative(),
    analysed_days: z.number().int().positive().max(366).optional(),
    evidence: z.array(z.string().min(1).max(400)).min(1).max(10),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export interface Experiment {
  id: string;
  title: string;
  problem_statement: string;
  evidence: string[];
  hypothesis: string;
  proposed_change: string;
  target_segment: string;
  primary_metric: string;
  guardrail_metrics: string[];
  design: {
    type: string;
    randomization_unit: string;
    allocation: string;
    baseline_rate: number;
    minimum_detectable_effect: number;
    sample_size_per_arm: number | null;
    estimated_duration_days: number | null;
    analysis: string;
  };
  risks: string[];
  support_conditions: string;
  reject_conditions: string;
  causal_caveat: string;
  pre_experiment_actions: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

interface Playbook {
  change: string;
  mechanism: string;
  guardrails: string[];
  risks: string[];
  pre: string[];
}

function playbook(f: Finding): Playbook {
  const step = f.funnel_step ? `${f.funnel_step.from}->${f.funnel_step.to}` : "";
  const seg = f.segment ? `${f.segment.value} ` : "";
  if (step === "payment_initiated->purchase_completed" || (f.metric === "purchase_conversion" && f.segment?.dimension === "platform")) {
    return {
      change: `Ship a resilient ${seg}checkout: automatic retry on payment-provider errors, a clear error message with a one-tap alternative payment method, and preserve the cart on failure.`,
      mechanism: "users who intend to buy are failing at payment rather than losing intent",
      guardrails: ["refund / chargeback rate", "payment error rate", "checkout latency (p95)", "support tickets about payments"],
      risks: [
        "A sudden drop concentrated in one platform often indicates a release or SDK defect; that should be fixed directly, not A/B tested.",
        "Retry logic may create duplicate charges if not idempotent.",
      ],
      pre: [
        `Check ${seg}release notes and payment-provider error logs for the affected dates.`,
        "Verify payment_initiated / purchase_completed instrumentation was not changed in the period.",
      ],
    };
  }
  if (step === "course_viewed->payment_initiated" || f.metric === "purchase_conversion") {
    return {
      change: `Add a free preview lesson and transparent pricing summary on the course page for ${seg || "all "}users before the buy button.`,
      mechanism: "uncertainty about course value or price discourages users from starting checkout",
      guardrails: ["refund rate", "course completion rate", "revenue per visitor"],
      risks: ["Free previews may satisfy some users' need and reduce purchases.", "Novelty effects in the first days."],
      pre: ["Review session recordings / qualitative feedback on the course page."],
    };
  }
  if (step === "registration->onboarding_completed" || f.metric === "onboarding_rate") {
    return {
      change: `Shorten onboarding to three screens with a skippable risk-profile quiz and progress indicator for ${seg || "new "}users.`,
      mechanism: "onboarding length or friction causes abandonment before users reach learning content",
      guardrails: ["day-7 retention", "share of users with a completed risk profile", "course_viewed rate"],
      risks: ["Collecting less profile data may weaken personalisation later."],
      pre: ["Instrument per-screen onboarding events to locate the exact drop point."],
    };
  }
  if (f.metric.startsWith("d") && f.metric.endsWith("retention")) {
    return {
      change: `Introduce a guided "first lesson in 5 minutes" path at the end of onboarding plus a day-2 lesson reminder for ${seg || "new "}users.`,
      mechanism: "users who reach a first learning success early form a habit and return",
      guardrails: ["notification opt-out rate", "uninstall rate", "purchase conversion"],
      risks: [
        "Onboarding completers may retain better because they were already more motivated (self-selection); pushing others through onboarding may not reproduce the gap.",
        "Notification fatigue.",
      ],
      pre: ["Confirm the retention gap persists within each acquisition channel to reduce confounding."],
    };
  }
  return {
    change: `Test a targeted improvement to the ${f.funnel_step ? `${f.funnel_step.from} → ${f.funnel_step.to}` : f.metric} experience for ${seg || "affected "}users.`,
    mechanism: "the identified friction point is causing the observed gap",
    guardrails: ["purchase conversion", "day-7 retention"],
    risks: ["The intervention is generic; qualitative research should refine it first."],
    pre: ["Gather qualitative evidence about the friction point."],
  };
}

/**
 * Deterministically build a structured experiment proposal from a finding.
 * All numbers in the output are derived from the finding's inputs (which the
 * agent must take from tool results) — no statistics are invented here.
 */
export function generateExperiment(finding: Finding, targetMetric: string): Experiment {
  const f = FindingSchema.parse(finding);
  const pb = playbook(f);
  const target = f.segment ? `${f.segment.dimension} = ${f.segment.value}` : "All eligible users";
  const gap = f.comparison_rate !== undefined ? Math.abs(f.comparison_rate - f.baseline_rate) : null;
  // aim to recover half of the observed gap, bounded to a practical range
  const mde = Math.min(0.1, Math.max(0.02, Math.round((gap !== null ? gap / 2 : f.baseline_rate * 0.1) * 1000) / 1000));
  const n = sampleSizePerArm(f.baseline_rate, mde);
  const perDay = f.analysed_days ? f.sample_size / f.analysed_days : null;
  const duration = n !== null && perDay && perDay > 0 ? Math.max(14, Math.ceil((2 * n) / perDay)) : null;
  const metricLabel = targetMetric || f.metric;

  const id = `exp-${f.metric}-${(f.segment?.value ?? "all").replace(/[^a-z0-9]+/gi, "-")}-${Math.round(f.baseline_rate * 1000)}`;
  return {
    id,
    title: (() => {
      const head = pb.change.split(":")[0].split(",")[0];
      return f.segment && !head.toLowerCase().includes(f.segment.value.toLowerCase()) ? `${f.segment.value}: ${head}` : head;
    })(),
    problem_statement: `${f.statement} Observed ${metricLabel} for ${target.toLowerCase()} is ${pct(f.baseline_rate)}${
      f.comparison_rate !== undefined ? ` versus ${pct(f.comparison_rate)} in the comparison group` : ""
    } (n = ${f.sample_size}).`,
    evidence: f.evidence,
    hypothesis: `If we ${pb.change.charAt(0).toLowerCase() + pb.change.slice(1).replace(/\.$/, "")}, then ${metricLabel} for ${target.toLowerCase()} will increase by at least ${pct(mde)} (absolute), because ${pb.mechanism}.`,
    proposed_change: pb.change,
    target_segment: target,
    primary_metric: metricLabel,
    guardrail_metrics: pb.guardrails,
    design: {
      type: "Randomised A/B test (control vs. treatment)",
      randomization_unit: "user_id (sticky assignment)",
      allocation: "50 / 50",
      baseline_rate: f.baseline_rate,
      minimum_detectable_effect: mde,
      sample_size_per_arm: n,
      estimated_duration_days: duration,
      analysis:
        "Two-sided two-proportion z-test at α = 0.05, power 0.8; pre-register the primary metric; run full weeks; no peeking-based early stopping.",
    },
    risks: [...pb.risks, ...(duration !== null && duration > 56 ? [`At current traffic the test needs about ${duration} days; consider a larger MDE, a broader segment, or a qualitative test first.`] : []), ...(f.sample_size < 100 ? [`Small evidence base (n = ${f.sample_size}); the finding may not replicate.`] : [])],
    support_conditions: `Treatment ${metricLabel} exceeds control by ≥ ${pct(mde)} with p < 0.05 and no guardrail degrades by more than its pre-agreed tolerance.`,
    reject_conditions: `The 95% CI for the treatment effect excludes a lift of ${pct(mde)}, or a guardrail metric degrades significantly.`,
    causal_caveat:
      "The underlying finding is observational. It identifies where to intervene, not proof that this change will work; only the experiment can establish causality.",
    pre_experiment_actions: pb.pre,
  };
}

/**
 * Live-agent loop tests with a scripted fake Claude client (no network, no key).
 * They verify the orchestration: tool execution, validation, bounded loop,
 * report validation, and API error handling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const script: Array<unknown> = [];
const calls: Array<{ messages: unknown[]; tools: { name: string }[] }> = [];

vi.mock("@anthropic-ai/sdk", async (orig) => {
  const real = await orig<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    beta = {
      messages: {
        create: async (params: { messages: unknown[]; tools: { name: string }[] }) => {
          calls.push({ messages: JSON.parse(JSON.stringify(params.messages)), tools: params.tools });
          const next = script.shift();
          if (next instanceof Error) throw next;
          if (!next) return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
          return next;
        },
      },
    };
    static AuthenticationError = real.default.AuthenticationError;
    static PermissionDeniedError = real.default.PermissionDeniedError;
    static NotFoundError = real.default.NotFoundError;
    static RateLimitError = real.default.RateLimitError;
    static BadRequestError = real.default.BadRequestError;
    static APIConnectionTimeoutError = real.default.APIConnectionTimeoutError;
    static APIConnectionError = real.default.APIConnectionError;
    static APIError = real.default.APIError;
  }
  return { ...real, default: FakeAnthropic };
});

import { runLiveInvestigation } from "../claude";
import { getSyntheticDataset } from "../../analytics/synthetic";
import { checkGrounding } from "../report";
import { toolDefinitions } from "../tools";

const ds = getSyntheticDataset();
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const turn = (...content: unknown[]) => ({ stop_reason: "tool_use", content });

beforeEach(() => {
  script.length = 0;
  calls.length = 0;
});

describe("live agent loop (mocked Claude)", () => {
  it("L01 executes requested tools, returns results with call ids, and accepts a valid report", async () => {
    script.push(
      turn(
        { type: "text", text: "Checking data and trend." },
        toolUse("a", "validate_event_data", { dataset_id: ds.meta.id }),
        toolUse("b", "get_metric_trend", { metric: "purchase_conversion", date_range: { preset: "last_7_days" } }),
      ),
      turn(
        toolUse("c", "submit_report", {
          summary: "Purchase conversion fell from 14.9% to 11.3% (p = 0.0247).",
          answer_status: "answered",
          findings: [
            { title: "Decline", statement: "Conversion 11.3% vs 14.9%.", type: "supported", confidence: "high", evidence: [{ tool_call_id: "T2", detail: "0.1126 vs 0.1487" }] },
          ],
          limitations: [],
          next_steps: [],
        }),
      ),
    );
    const r = await runLiveInvestigation("Why did conversion decline?", ds);
    expect(r.error).toBeUndefined();
    expect(r.steps.map((s) => [s.id, s.tool, s.status])).toEqual([
      ["T1", "validate_event_data", "ok"],
      ["T2", "get_metric_trend", "ok"],
    ]);
    // both tool results returned in ONE user message
    const toolResultMsg = calls[1].messages.at(-1) as { role: string; content: { type: string; content: string }[] };
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content).toHaveLength(2);
    expect(toolResultMsg.content[1].content).toContain('"tool_call_id":"T2"');
    expect(r.report.answer_status).toBe("answered");
    expect(r.report.grounding.unverified_numbers).toEqual([]);
    expect(calls[0].tools.map((t) => t.name)).toContain("submit_report");
  });

  it("L02 rejects unapproved tools and malformed inputs without executing them", async () => {
    script.push(
      turn(toolUse("a", "run_sql", { q: "select *" }), toolUse("b", "compare_segments", { metric: "vibes", segment_dimension: "platform" })),
    );
    const r = await runLiveInvestigation("x", ds);
    expect(r.steps.map((s) => s.status)).toEqual(["error", "error"]);
    const res = calls[1].messages.at(-1) as { content: { is_error: boolean }[] };
    expect(res.content.every((c) => c.is_error)).toBe(true);
    expect(r.report.answer_status).toBe("partially_answered");
  });

  it("L03 returns validation errors for a malformed report so the model can retry", async () => {
    script.push(
      turn(toolUse("a", "submit_report", { summary: "bad", answer_status: "certain" })),
      turn(toolUse("b", "submit_report", { summary: "ok", answer_status: "insufficient_evidence", findings: [], limitations: ["n/a"], next_steps: [] })),
    );
    const r = await runLiveInvestigation("x", ds);
    const first = calls[1].messages.at(-1) as { content: { is_error: boolean; content: string }[] };
    expect(first.content[0].is_error).toBe(true);
    expect(first.content[0].content).toMatch(/failed validation/);
    expect(r.report.answer_status).toBe("insufficient_evidence");
  });

  it("L04 the loop is bounded even if the model never stops calling tools", async () => {
    for (let i = 0; i < 50; i++) script.push(turn(toolUse(`x${i}`, "validate_event_data", { dataset_id: ds.meta.id })));
    const r = await runLiveInvestigation("x", ds);
    expect(calls.length).toBe(10);
    expect(r.steps.length).toBeLessThanOrEqual(20);
    expect(r.report.limitations.join(" ")).toMatch(/without submitting/);
  });

  it("L05 maps API failures to safe messages and keeps partial results", async () => {
    script.push(turn(toolUse("a", "validate_event_data", { dataset_id: ds.meta.id })), new Error("socket hang up"));
    const r = await runLiveInvestigation("x", ds);
    expect(r.error).toBe("socket hang up");
    expect(r.steps).toHaveLength(1);
    expect(r.report.limitations.join(" ")).toMatch(/Error/);
  });

  it("L06 handles refusals", async () => {
    script.push({ stop_reason: "refusal", content: [] });
    const r = await runLiveInvestigation("x", ds);
    expect(r.error).toMatch(/declined/);
  });
});

describe("grounding checker", () => {
  it("L07 flags fabricated numbers and evidence pointing at non-existent tool calls", () => {
    const steps = [{ id: "T1", tool: "get_metric_trend", input: {}, status: "ok" as const, output: { current: { value: 0.1126 }, previous: { value: 0.1487 } }, duration_ms: 1 }];
    const g = checkGrounding(
      {
        summary: "Conversion fell from 14.9% to 11.3%, and revenue dropped 23.4% while 4,512 users churned.",
        answer_status: "answered",
        findings: [{ title: "x", statement: "y", type: "supported", confidence: "high", evidence: [{ tool_call_id: "T9", detail: "made up" }] }],
        limitations: [],
        next_steps: [],
      },
      steps,
    );
    expect(g.unverified_numbers).toEqual(["23.4%", "4,512"]);
    expect(g.invalid_evidence_refs).toEqual(["T9"]);
    expect(g.unsupported_findings).toEqual(["x"]);
  });

  it("L08 tool definitions expose exactly the six approved analytical tools with object schemas", () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(
      ["analyze_funnel", "calculate_cohort_retention", "compare_segments", "generate_experiment", "get_metric_trend", "validate_event_data"].sort(),
    );
    for (const d of defs) expect(d.input_schema.type).toBe("object");
  });
});

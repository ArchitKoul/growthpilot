import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { DatasetRefSchema, resolveDataset } from "@/lib/server/dataset";
import { runDemoInvestigation } from "@/lib/agent/demo";
import { liveAgentAvailable, runLiveInvestigation } from "@/lib/agent/claude";
import { saveInvestigation } from "@/lib/server/persistence";

export const maxDuration = 300;

const MAX_BODY_BYTES = 12 * 1024 * 1024;

const BodySchema = z
  .object({
    question: z.string().trim().min(3, "Question is too short").max(1000, "Question is too long (max 1000 chars)"),
    mode: z.enum(["auto", "demo", "live"]).default("auto"),
    dataset: DatasetRefSchema,
  })
  .strict();

export async function POST(req: NextRequest) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return NextResponse.json({ error: "Request body too large." }, { status: 413 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `${issue.path.join(".") || "body"}: ${issue.message}` }, { status: 400 });
  }
  const { question, mode, dataset: ref } = parsed.data;
  const dataset = resolveDataset(ref);

  const live = liveAgentAvailable();
  if (mode === "live" && !live)
    return NextResponse.json({ error: "Live AI mode requires ANTHROPIC_API_KEY on the server." }, { status: 400 });

  const result = mode === "demo" || !live ? runDemoInvestigation(question, dataset) : await runLiveInvestigation(question, dataset);
  const persisted = await saveInvestigation(result);
  return NextResponse.json({ result, persisted });
}

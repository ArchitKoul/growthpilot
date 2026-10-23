import { NextResponse } from "next/server";
import { connection } from "next/server";
import { liveAgentAvailable, DEFAULT_MODEL } from "@/lib/agent/claude";
import { persistenceEnabled } from "@/lib/server/persistence";

/** Reports capabilities only — never key material. */
export async function GET() {
  await connection();
  const live = liveAgentAvailable();
  return NextResponse.json({
    liveAvailable: live,
    model: live ? process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL : null,
    persistence: persistenceEnabled() ? "supabase" : "browser",
  });
}

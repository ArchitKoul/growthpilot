import { NextResponse } from "next/server";
import { connection } from "next/server";
import { listInvestigations } from "@/lib/server/persistence";

export async function GET() {
  await connection();
  const items = await listInvestigations();
  return NextResponse.json({ enabled: items !== null, items: items ?? [] });
}

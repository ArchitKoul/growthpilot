import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InvestigationResult } from "../agent/report";

let client: SupabaseClient | null | undefined;

export function persistenceEnabled(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  client = persistenceEnabled()
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    : null;
  return client;
}

/**
 * Optional server-side persistence of investigation results (no raw events,
 * no secrets). Without Supabase configured the browser keeps history locally.
 */
export async function saveInvestigation(r: InvestigationResult): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  const { error } = await c.from("investigations").insert({
    id: r.id,
    question: r.question,
    mode: r.mode,
    model: r.model,
    dataset_id: r.dataset.id,
    dataset_name: r.dataset.name,
    answer_status: r.report.answer_status,
    result: r,
    created_at: r.started_at,
  });
  if (error) console.error("[persistence] insert failed:", error.code);
  return !error;
}

export async function listInvestigations(limit = 20): Promise<InvestigationResult[] | null> {
  const c = getClient();
  if (!c) return null;
  const { data, error } = await c.from("investigations").select("result").order("created_at", { ascending: false }).limit(limit);
  if (error) {
    console.error("[persistence] list failed:", error.code);
    return null;
  }
  return (data ?? []).map((d) => d.result as InvestigationResult);
}

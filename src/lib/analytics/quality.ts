import { DAY_MS, type AnalyticsEvent } from "./schema";
import { eventKey } from "./core";

export type Severity = "info" | "warning" | "error";

export interface QualityCheck {
  id: string;
  label: string;
  severity: Severity;
  count: number;
  detail: string;
  examples: string[];
}

export interface QualityReport {
  dataset_id: string;
  total_events: number;
  unique_users: number;
  first_event: string | null;
  last_event: string | null;
  checks: QualityCheck[];
  /** "pass" when no warning/error checks fired */
  status: "pass" | "warnings" | "errors";
  /** extra row-level issues from CSV parsing (rows rejected before analysis) */
  rejected_rows: number;
}

/**
 * Data-quality checks on parsed events. Checks never modify data; analytics
 * functions apply de-duplication independently via prepare().
 */
export function validateEvents(
  datasetId: string,
  events: AnalyticsEvent[],
  opts: { rejectedRows?: number; now?: number } = {},
): QualityReport {
  const now = opts.now ?? Date.now();
  const checks: QualityCheck[] = [];
  const add = (c: Omit<QualityCheck, "examples"> & { examples?: string[] }) =>
    checks.push({ ...c, examples: (c.examples ?? []).slice(0, 5) });

  // duplicates
  const seen = new Set<string>();
  const dupEx: string[] = [];
  let dups = 0;
  for (const e of events) {
    const k = eventKey(e);
    if (seen.has(k)) {
      dups++;
      if (dupEx.length < 5) dupEx.push(`${e.user_id} ${e.event_name} @ ${new Date(e.ts).toISOString()}`);
    } else seen.add(k);
  }
  add({
    id: "duplicates",
    label: "Duplicate events",
    severity: dups ? "warning" : "info",
    count: dups,
    detail: dups
      ? `${dups} exact duplicates (same user_id, event_name, timestamp). They are ignored by all analytics.`
      : "No exact duplicate events.",
    examples: dupEx,
  });

  // missing session ids
  const missingSession = events.filter((e) => !e.session_id).length;
  add({
    id: "missing_session_id",
    label: "Missing session_id",
    severity: missingSession / Math.max(1, events.length) > 0.05 ? "warning" : "info",
    count: missingSession,
    detail: `${missingSession} events have no session_id (not used in core metrics).`,
  });

  // purchases missing revenue / non-purchase with revenue
  const purchNoRev = events.filter((e) => e.event_name === "purchase_completed" && e.revenue === null);
  add({
    id: "purchase_missing_revenue",
    label: "Purchases without revenue",
    severity: purchNoRev.length ? "warning" : "info",
    count: purchNoRev.length,
    detail: purchNoRev.length
      ? `${purchNoRev.length} purchase_completed events have no revenue; revenue totals are understated.`
      : "All purchases have revenue.",
    examples: purchNoRev.map((e) => e.user_id),
  });

  // course events missing category
  const noCat = events.filter((e) => (e.event_name === "course_viewed" || e.event_name === "purchase_completed") && !e.course_category);
  add({
    id: "missing_category",
    label: "Course events without category",
    severity: noCat.length ? "warning" : "info",
    count: noCat.length,
    detail: `${noCat.length} course_viewed/purchase_completed events have no course_category.`,
    examples: noCat.map((e) => e.user_id),
  });

  // future timestamps
  const future = events.filter((e) => e.ts > now + DAY_MS);
  add({
    id: "future_timestamps",
    label: "Future timestamps",
    severity: future.length ? "error" : "info",
    count: future.length,
    detail: future.length ? `${future.length} events are dated more than a day in the future.` : "No future-dated events.",
    examples: future.map((e) => new Date(e.ts).toISOString()),
  });

  // per-user ordering and registration coverage
  const firstReg = new Map<string, number>();
  const users = new Set<string>();
  for (const e of events) {
    users.add(e.user_id);
    if (e.event_name === "registration") {
      const cur = firstReg.get(e.user_id);
      if (cur === undefined || e.ts < cur) firstReg.set(e.user_id, e.ts);
    }
  }
  const noReg = [...users].filter((u) => !firstReg.has(u));
  add({
    id: "users_without_registration",
    label: "Users without registration",
    severity: noReg.length ? "warning" : "info",
    count: noReg.length,
    detail: `${noReg.length} users have events but no registration event; they are excluded from cohorts and registration-based funnels.`,
    examples: noReg,
  });
  const beforeReg = events.filter((e) => {
    const r = firstReg.get(e.user_id);
    return r !== undefined && e.ts < r;
  });
  add({
    id: "events_before_registration",
    label: "Events before registration",
    severity: beforeReg.length ? "warning" : "info",
    count: beforeReg.length,
    detail: `${beforeReg.length} events occur before the user's registration (clock skew or identity merge issues).`,
    examples: beforeReg.map((e) => `${e.user_id} ${e.event_name}`),
  });
  const multiReg = events.filter((e) => e.event_name === "registration").length - firstReg.size;
  add({
    id: "multiple_registrations",
    label: "Repeated registrations",
    severity: multiReg > 0 ? "warning" : "info",
    count: multiReg,
    detail: `${multiReg} extra registration events (first one is used).`,
  });

  const purchNoInit = (() => {
    const inits = new Set(events.filter((e) => e.event_name === "payment_initiated").map((e) => e.user_id));
    return events.filter((e) => e.event_name === "purchase_completed" && !inits.has(e.user_id));
  })();
  add({
    id: "purchase_without_payment_initiated",
    label: "Purchases without payment_initiated",
    severity: purchNoInit.length ? "warning" : "info",
    count: purchNoInit.length,
    detail: `${purchNoInit.length} purchases from users with no payment_initiated event (possible tracking gap).`,
    examples: purchNoInit.map((e) => e.user_id),
  });

  if (opts.rejectedRows)
    add({
      id: "rejected_rows",
      label: "Rejected rows",
      severity: "warning",
      count: opts.rejectedRows,
      detail: `${opts.rejectedRows} rows failed schema validation at import and are not analysed.`,
    });

  if (events.length === 0)
    add({ id: "empty", label: "Empty dataset", severity: "error", count: 0, detail: "The dataset contains no valid events." });

  const status = checks.some((c) => c.severity === "error") ? "errors" : checks.some((c) => c.severity === "warning") ? "warnings" : "pass";
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  return {
    dataset_id: datasetId,
    total_events: events.length,
    unique_users: users.size,
    first_event: events.length ? new Date(min).toISOString() : null,
    last_event: events.length ? new Date(max).toISOString() : null,
    checks,
    status,
    rejected_rows: opts.rejectedRows ?? 0,
  };
}

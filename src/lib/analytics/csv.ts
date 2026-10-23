import { EventSchema, type AnalyticsEvent } from "./schema";

export const REQUIRED_FIELDS = ["user_id", "event_name", "timestamp", "platform", "acquisition_channel"] as const;
export const OPTIONAL_FIELDS = ["course_category", "session_id", "revenue"] as const;
export const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS] as const;
export type FieldName = (typeof ALL_FIELDS)[number];
/** target field → source column header (or "" for unmapped) */
export type ColumnMapping = Record<FieldName, string>;

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 200_000;

/** RFC-4180-style CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const ALIASES: Record<FieldName, string[]> = {
  user_id: ["user_id", "userid", "user", "uid", "distinct_id"],
  event_name: ["event_name", "event", "name", "event_type"],
  timestamp: ["timestamp", "ts", "time", "event_time", "created_at"],
  platform: ["platform", "os", "device_platform"],
  acquisition_channel: ["acquisition_channel", "channel", "source", "utm_source"],
  course_category: ["course_category", "category"],
  session_id: ["session_id", "session"],
  revenue: ["revenue", "amount", "price", "value"],
};

/** Guess a mapping from header names (case/space-insensitive aliases). */
export function suggestMapping(headers: string[]): ColumnMapping {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const out = {} as ColumnMapping;
  for (const f of ALL_FIELDS) {
    out[f] = headers.find((h) => ALIASES[f].includes(norm(h))) ?? "";
  }
  return out;
}

export interface RowError {
  row: number; // 1-based data row (excluding header)
  message: string;
}

export interface CsvImportResult {
  events: AnalyticsEvent[];
  errors: RowError[];
  totalRows: number;
  missingRequired: FieldName[];
}

function parseTimestamp(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  // require an ISO-like date so ambiguous formats (03/04/2025) are rejected
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) || s.length === 10 ? s : `${s}Z`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : null;
}

const lower = (s: string | undefined) => (s ?? "").trim().toLowerCase();

/** Map + validate rows into events. Invalid rows are reported, never silently coerced. */
export function importCsv(rows: string[][], mapping: ColumnMapping): CsvImportResult {
  const [header, ...data] = rows;
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f] || !header?.includes(mapping[f]));
  if (!header || missingRequired.length) return { events: [], errors: [], totalRows: data.length, missingRequired: [...missingRequired] };
  const idx = {} as Record<FieldName, number>;
  for (const f of ALL_FIELDS) idx[f] = mapping[f] ? header.indexOf(mapping[f]) : -1;
  const get = (r: string[], f: FieldName) => (idx[f] >= 0 ? r[idx[f]] : undefined);

  const events: AnalyticsEvent[] = [];
  const errors: RowError[] = [];
  data.slice(0, MAX_ROWS).forEach((r, i) => {
    const ts = parseTimestamp(get(r, "timestamp") ?? "");
    if (ts === null) {
      errors.push({ row: i + 1, message: `invalid timestamp "${get(r, "timestamp") ?? ""}"` });
      return;
    }
    const revRaw = (get(r, "revenue") ?? "").trim();
    const rev = revRaw === "" ? null : Number(revRaw);
    const cat = lower(get(r, "course_category"));
    const sess = (get(r, "session_id") ?? "").trim();
    const candidate = {
      user_id: (get(r, "user_id") ?? "").trim(),
      event_name: lower(get(r, "event_name")),
      ts,
      platform: lower(get(r, "platform")),
      acquisition_channel: lower(get(r, "acquisition_channel")),
      course_category: cat === "" ? null : cat,
      session_id: sess === "" ? null : sess,
      revenue: rev,
    };
    const parsed = EventSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({ row: i + 1, message: `${issue.path.join(".") || "row"}: ${issue.message}` });
      return;
    }
    events.push(parsed.data);
  });
  if (data.length > MAX_ROWS) errors.push({ row: MAX_ROWS + 1, message: `row limit ${MAX_ROWS} exceeded; remaining rows ignored` });
  return { events, errors, totalRows: data.length, missingRequired: [] };
}

/** Serialize events back to CSV (used for downloading the synthetic dataset). */
export function toCsv(events: AnalyticsEvent[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [ALL_FIELDS.join(",")];
  for (const e of events) {
    lines.push(
      [e.user_id, e.event_name, new Date(e.ts).toISOString(), e.platform, e.acquisition_channel, e.course_category ?? "", e.session_id ?? "", e.revenue ?? ""]
        .map((v) => esc(String(v)))
        .join(","),
    );
  }
  return lines.join("\n");
}

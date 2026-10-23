import { z } from "zod";
import {
  CATEGORIES,
  CHANNELS,
  DAY_MS,
  PLATFORMS,
  type AnalyticsEvent,
  type Category,
  type Channel,
  type EventName,
  type Platform,
} from "./schema";

/* ------------------------------------------------------------------ */
/* Prepared (indexed) data                                             */
/* ------------------------------------------------------------------ */

export interface UserProfile {
  id: string;
  /** Platform/channel come from the registration event (or first event if none). */
  platform: Platform;
  channel: Channel;
  registeredAt: number | null;
  /** Category of the user's first course_viewed event (null if never viewed). */
  firstCategory: Category | null;
  /** Earliest onboarding_completed timestamp, if any. */
  onboardedAt: number | null;
  /** Sorted timestamps per event name (after de-duplication). */
  byEvent: Partial<Record<EventName, number[]>>;
  /** Sorted timestamps of qualifying activity events. */
  activity: number[];
}

export interface PreparedData {
  events: AnalyticsEvent[];
  users: Map<string, UserProfile>;
  duplicatesRemoved: number;
  minTs: number;
  maxTs: number;
}

const ACTIVITY: ReadonlySet<string> = new Set([
  "app_open",
  "lesson_completed",
  "course_viewed",
  "payment_initiated",
  "purchase_completed",
]);

export function eventKey(e: AnalyticsEvent): string {
  return `${e.user_id}|${e.event_name}|${e.ts}`;
}

/**
 * Sort events, drop exact duplicates (same user_id + event_name + timestamp),
 * and build per-user indexes. All analytics read from this structure so
 * every calculation applies the same identity and de-duplication rules.
 */
export function prepare(raw: AnalyticsEvent[]): PreparedData {
  const sorted = [...raw].sort((a, b) => a.ts - b.ts);
  const seen = new Set<string>();
  const events: AnalyticsEvent[] = [];
  for (const e of sorted) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    events.push(e);
  }

  const users = new Map<string, UserProfile>();
  for (const e of events) {
    let u = users.get(e.user_id);
    if (!u) {
      u = {
        id: e.user_id,
        platform: e.platform,
        channel: e.acquisition_channel,
        registeredAt: null,
        firstCategory: null,
        onboardedAt: null,
        byEvent: {},
        activity: [],
      };
      users.set(e.user_id, u);
    }
    if (e.event_name === "registration" && u.registeredAt === null) {
      u.registeredAt = e.ts;
      u.platform = e.platform;
      u.channel = e.acquisition_channel;
    }
    if (e.event_name === "onboarding_completed" && u.onboardedAt === null) u.onboardedAt = e.ts;
    if (e.event_name === "course_viewed" && u.firstCategory === null && e.course_category) {
      u.firstCategory = e.course_category;
    }
    (u.byEvent[e.event_name] ??= []).push(e.ts);
    if (ACTIVITY.has(e.event_name)) u.activity.push(e.ts);
  }

  return {
    events,
    users,
    duplicatesRemoved: raw.length - events.length,
    minTs: events.length ? events[0].ts : 0,
    maxTs: events.length ? events[events.length - 1].ts : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Date ranges                                                         */
/* ------------------------------------------------------------------ */

export const DATE_PRESETS = ["last_7_days", "last_14_days", "last_30_days", "last_90_days", "all"] as const;

export const DateRangeSchema = z.union([
  z.object({ preset: z.enum(DATE_PRESETS) }).strict(),
  z
    .object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD"),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD"),
    })
    .strict(),
]);
export type DateRange = z.infer<typeof DateRangeSchema>;

export interface ResolvedRange {
  /** inclusive, epoch ms at 00:00 UTC */
  start: number;
  /** exclusive, epoch ms at 00:00 UTC of the day after the last day */
  end: number;
  label: string;
}

export const startOfDay = (ts: number) => Math.floor(ts / DAY_MS) * DAY_MS;
export const isoDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Resolve a date range against the dataset's last observed day ("as of").
 * Relative presets are anchored to the data, never the wall clock, so results
 * are reproducible. Ranges are whole UTC days; `end` is exclusive.
 */
export function resolveRange(range: DateRange | undefined, data: Pick<PreparedData, "minTs" | "maxTs">): ResolvedRange {
  const lastDayEnd = startOfDay(data.maxTs) + DAY_MS;
  const firstDay = startOfDay(data.minTs);
  if (!range || ("preset" in range && range.preset === "all")) {
    return { start: firstDay, end: lastDayEnd, label: `${isoDay(firstDay)} → ${isoDay(lastDayEnd - DAY_MS)}` };
  }
  if ("preset" in range) {
    const days = Number(range.preset.split("_")[1]);
    const start = Math.max(firstDay, lastDayEnd - days * DAY_MS);
    return { start, end: lastDayEnd, label: `${isoDay(start)} → ${isoDay(lastDayEnd - DAY_MS)}` };
  }
  const start = Date.parse(`${range.start}T00:00:00Z`);
  const end = Date.parse(`${range.end}T00:00:00Z`) + DAY_MS;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`Invalid date range ${range.start} → ${range.end}`);
  }
  return { start, end, label: `${range.start} → ${range.end}` };
}

/** The equal-length period immediately before `r`. */
export function previousRange(r: ResolvedRange): ResolvedRange {
  const len = r.end - r.start;
  return { start: r.start - len, end: r.start, label: `${isoDay(r.start - len)} → ${isoDay(r.start - DAY_MS)}` };
}

/* ------------------------------------------------------------------ */
/* Segment filters                                                     */
/* ------------------------------------------------------------------ */

export const SEGMENT_DIMENSIONS = ["platform", "acquisition_channel", "course_category", "onboarding_status"] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];
export const ONBOARDING_STATUSES = ["completed", "not_completed"] as const;

export const SegmentFilterSchema = z
  .object({
    platform: z.array(z.enum(PLATFORMS)).optional(),
    acquisition_channel: z.array(z.enum(CHANNELS)).optional(),
    course_category: z.array(z.enum(CATEGORIES)).optional(),
    onboarding_status: z.array(z.enum(ONBOARDING_STATUSES)).optional(),
  })
  .strict();
export type SegmentFilter = z.infer<typeof SegmentFilterSchema>;

/** Segment value of a user on a dimension. Category = first viewed course category. */
export function segmentValue(u: UserProfile, dim: SegmentDimension): string {
  switch (dim) {
    case "platform":
      return u.platform;
    case "acquisition_channel":
      return u.channel;
    case "course_category":
      return u.firstCategory ?? "no_course_viewed";
    case "onboarding_status":
      return u.onboardedAt !== null ? "completed" : "not_completed";
  }
}

export function matchesFilter(u: UserProfile, f: SegmentFilter | undefined): boolean {
  if (!f) return true;
  if (f.platform?.length && !f.platform.includes(u.platform)) return false;
  if (f.acquisition_channel?.length && !f.acquisition_channel.includes(u.channel)) return false;
  if (f.course_category?.length && (!u.firstCategory || !f.course_category.includes(u.firstCategory))) return false;
  if (f.onboarding_status?.length && !f.onboarding_status.includes(u.onboardedAt !== null ? "completed" : "not_completed"))
    return false;
  return true;
}

export function filterUsers(data: PreparedData, f?: SegmentFilter): UserProfile[] {
  const out: UserProfile[] = [];
  for (const u of data.users.values()) if (matchesFilter(u, f)) out.push(u);
  return out;
}

export function describeFilter(f?: SegmentFilter): string {
  if (!f) return "all users";
  const parts = Object.entries(f)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${k} ∈ {${(v as string[]).join(", ")}}`);
  return parts.length ? parts.join("; ") : "all users";
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** First timestamp in a sorted array with lo <= t < hi (binary search). */
export function firstInWindow(sorted: number[] | undefined, lo: number, hi: number): number | null {
  if (!sorted || sorted.length === 0) return null;
  let a = 0;
  let b = sorted.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (sorted[m] < lo) a = m + 1;
    else b = m;
  }
  return a < sorted.length && sorted[a] < hi ? sorted[a] : null;
}

/** Safe ratio: returns null (not 0, not NaN) when the denominator is zero. */
export function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export const round = (x: number | null, dp = 4): number | null =>
  x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp;

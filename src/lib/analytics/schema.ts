import { z } from "zod";

/** Canonical event names for the stock-market learning app. */
export const EVENT_NAMES = [
  "registration",
  "onboarding_completed",
  "app_open",
  "lesson_completed",
  "course_viewed",
  "payment_initiated",
  "purchase_completed",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const PLATFORMS = ["android", "ios", "web"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CHANNELS = ["organic", "paid", "referral"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CATEGORIES = [
  "stock_basics",
  "technical_analysis",
  "options_trading",
  "personal_finance",
  "crypto",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const DEFAULT_FUNNEL: EventName[] = [
  "registration",
  "onboarding_completed",
  "course_viewed",
  "payment_initiated",
  "purchase_completed",
];

/**
 * Events that count as "qualifying activity" for retention.
 * registration and onboarding_completed are excluded: they happen once and
 * would inflate early-day retention.
 */
export const QUALIFYING_ACTIVITY: ReadonlySet<EventName> = new Set<EventName>([
  "app_open",
  "lesson_completed",
  "course_viewed",
  "payment_initiated",
  "purchase_completed",
]);

/** A validated analytics event. `ts` is epoch milliseconds (UTC). */
export const EventSchema = z.object({
  user_id: z.string().min(1).max(128),
  event_name: z.enum(EVENT_NAMES),
  ts: z.number().int().nonnegative(),
  platform: z.enum(PLATFORMS),
  acquisition_channel: z.enum(CHANNELS),
  course_category: z.enum(CATEGORIES).nullable(),
  session_id: z.string().max(128).nullable(),
  revenue: z.number().nonnegative().nullable(),
});
export type AnalyticsEvent = z.infer<typeof EventSchema>;

export const DatasetMetaSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  source: z.enum(["synthetic", "upload"]),
  createdAt: z.string(),
  rowCount: z.number().int().nonnegative(),
});
export type DatasetMeta = z.infer<typeof DatasetMetaSchema>;

export interface Dataset {
  meta: DatasetMeta;
  events: AnalyticsEvent[];
}

export const DAY_MS = 86_400_000;

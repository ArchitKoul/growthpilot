import type { AnalyticsEvent, EventName, Platform, Channel, Category } from "../schema";
import { DAY_MS } from "../schema";

export const T0 = Date.parse("2026-01-01T10:00:00Z");
export const day = (n: number, minutes = 0) => T0 + n * DAY_MS + minutes * 60_000;

export function ev(
  user: string,
  name: EventName,
  ts: number,
  extra: Partial<{ platform: Platform; channel: Channel; category: Category | null; revenue: number | null; session: string | null }> = {},
): AnalyticsEvent {
  return {
    user_id: user,
    event_name: name,
    ts,
    platform: extra.platform ?? "ios",
    acquisition_channel: extra.channel ?? "organic",
    course_category: "category" in extra ? (extra.category ?? null) : (name === "course_viewed" || name === "purchase_completed" ? "stock_basics" : null),
    session_id: extra.session === undefined ? `${user}-s` : extra.session,
    revenue: "revenue" in extra ? (extra.revenue ?? null) : name === "purchase_completed" ? 29 : null,
  };
}

/** A user who walks the full funnel on day `d`. */
export function fullFunnel(user: string, d: number, extra: Parameters<typeof ev>[3] = {}): AnalyticsEvent[] {
  return [
    ev(user, "registration", day(d, 0), extra),
    ev(user, "onboarding_completed", day(d, 5), extra),
    ev(user, "course_viewed", day(d, 10), extra),
    ev(user, "payment_initiated", day(d, 12), extra),
    ev(user, "purchase_completed", day(d, 14), extra),
  ];
}

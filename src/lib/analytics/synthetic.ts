import {
  CATEGORIES,
  DAY_MS,
  type AnalyticsEvent,
  type Category,
  type Channel,
  type Dataset,
  type EventName,
  type Platform,
} from "./schema";

/**
 * Synthetic dataset for "StockSchool", a fictional stock-market learning app.
 * Fully deterministic for a given seed. See docs/DATASET.md for the planted
 * behaviours an investigation should be able to recover.
 */
export interface SyntheticOptions {
  seed?: number;
  days?: number;
  usersPerDay?: number;
  /** last observed day (UTC, YYYY-MM-DD) */
  endDate?: string;
  /** plant the Android payment regression in the final 7 days */
  injectAndroidPaymentRegression?: boolean;
  /** fraction of events duplicated to exercise de-duplication */
  duplicateRate?: number;
}

export const SYNTHETIC_DATASET_ID = "synthetic-stockschool-v1";
export const SYNTHETIC_DEFAULTS: Required<SyntheticOptions> = {
  seed: 42,
  days: 120,
  usersPerDay: 60,
  endDate: "2026-10-20",
  injectAndroidPaymentRegression: true,
  duplicateRate: 0.004,
};

export const COURSE_PRICES: Record<Category, number> = {
  stock_basics: 29,
  technical_analysis: 49,
  options_trading: 79,
  personal_finance: 19,
  crypto: 59,
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function generateSyntheticEvents(options: SyntheticOptions = {}): AnalyticsEvent[] {
  const o = { ...SYNTHETIC_DEFAULTS, ...options };
  const rng = mulberry32(o.seed);
  const end = Date.parse(`${o.endDate}T00:00:00Z`) + DAY_MS; // exclusive
  const start = end - o.days * DAY_MS;
  const regressionStart = end - 7 * DAY_MS;
  const events: AnalyticsEvent[] = [];
  let userSeq = 0;

  for (let day = 0; day < o.days; day++) {
    const dayStart = start + day * DAY_MS;
    const n = Math.round(o.usersPerDay * (0.85 + rng() * 0.3) * (new Date(dayStart).getUTCDay() % 6 === 0 ? 0.8 : 1));
    for (let k = 0; k < n; k++) {
      const uid = `u${String(++userSeq).padStart(5, "0")}`;
      const platform = pick<Platform>(rng, ["android", "ios", "web"], [0.45, 0.35, 0.2]);
      const channel = pick<Channel>(rng, ["organic", "paid", "referral"], [0.5, 0.35, 0.15]);
      const prefCat = pick<Category>(rng, CATEGORIES, [0.35, 0.25, 0.15, 0.15, 0.1]);
      const regTs = dayStart + Math.floor(rng() * (DAY_MS - 3 * 3600_000));
      let sessionN = 0;
      const sessionFor = () => `${uid}-s${++sessionN}`;
      const push = (name: EventName, ts: number, session: string, extra: Partial<AnalyticsEvent> = {}) => {
        if (ts >= end) return;
        events.push({
          user_id: uid,
          event_name: name,
          ts: Math.floor(ts),
          platform,
          acquisition_channel: channel,
          course_category: null,
          session_id: session,
          revenue: null,
          ...extra,
        });
      };

      const s0 = sessionFor();
      push("registration", regTs, s0);
      const onboardP = { ios: 0.72, android: 0.64, web: 0.52 }[platform] - (channel === "paid" ? 0.08 : 0);
      const onboarded = rng() < onboardP;
      let t = regTs + (2 + rng() * 18) * 60_000;
      if (onboarded) push("onboarding_completed", t, s0);

      let purchased = false;
      let viewedAny = false;
      const viewCourse = (ts: number, session: string, firstChance: boolean) => {
        const cat = rng() < 0.8 ? prefCat : pick<Category>(rng, CATEGORIES, [1, 1, 1, 1, 1]);
        push("course_viewed", ts, session, { course_category: cat });
        viewedAny = true;
        if (purchased) return;
        let initP = firstChance ? 0.4 : 0.1;
        if (channel === "paid") initP -= 0.06;
        if (cat === "crypto") initP += 0.08;
        if (platform === "web") initP -= 0.05;
        if (!onboarded) initP -= 0.08;
        if (rng() >= initP) return;
        const ti = ts + (1 + rng() * 6) * 60_000;
        push("payment_initiated", ti, session, { course_category: cat });
        let completeP = platform === "ios" ? 0.8 : 0.77;
        if (o.injectAndroidPaymentRegression && platform === "android" && ti >= regressionStart) completeP = 0.4;
        if (rng() < completeP) {
          purchased = true;
          push("purchase_completed", ti + (0.5 + rng() * 3) * 60_000, session, {
            course_category: cat,
            revenue: COURSE_PRICES[cat],
          });
        }
      };

      if (rng() < (onboarded ? 0.6 : 0.32)) {
        t += (1 + rng() * 10) * 60_000;
        viewCourse(t, s0, true);
      }

      // daily engagement with exponential decay; onboarding completers retain better
      const a = onboarded ? 0.55 : 0.35;
      const tau = onboarded ? 14 : 6;
      const floor = (onboarded ? 0.11 : 0.03) * (channel === "referral" ? 1.3 : 1) * (channel === "paid" ? 0.8 : 1);
      let firstCourseChanceUsed = false;
      for (let d = 1; d <= 60; d++) {
        const dayTs = regTs + d * DAY_MS;
        if (dayTs >= end) break;
        const p = a * Math.exp(-d / tau) + floor;
        if (rng() >= p) continue;
        const s = sessionFor();
        const ts = dayTs + rng() * 6 * 3600_000;
        push("app_open", ts, s);
        if (rng() < 0.6) push("lesson_completed", ts + (5 + rng() * 20) * 60_000, s);
        if (rng() < 0.22) {
          const first = !firstCourseChanceUsed && !viewedAny;
          firstCourseChanceUsed = true;
          viewCourse(ts + 30 * 60_000, s, first);
        }
      }
    }
  }

  // data-quality noise: exact duplicates and a few missing session ids
  const dupCount = Math.floor(events.length * o.duplicateRate);
  for (let i = 0; i < dupCount; i++) events.push({ ...events[Math.floor(rng() * events.length)] });
  for (let i = 0; i < Math.floor(events.length * 0.005); i++) events[Math.floor(rng() * events.length)].session_id = null;

  return events.sort((x, y) => x.ts - y.ts);
}

let cached: Dataset | null = null;

/** The default demo dataset (memoised; deterministic). */
export function getSyntheticDataset(): Dataset {
  if (!cached) {
    const events = generateSyntheticEvents();
    cached = {
      meta: {
        id: SYNTHETIC_DATASET_ID,
        name: "StockSchool synthetic events (seed 42)",
        source: "synthetic",
        createdAt: `${SYNTHETIC_DEFAULTS.endDate}T23:59:59Z`,
        rowCount: events.length,
      },
      events,
    };
  }
  return cached;
}

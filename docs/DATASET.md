# Synthetic dataset: StockSchool

`src/lib/analytics/synthetic.ts` generates event data for **StockSchool**, a fictional stock-market learning app. The generator is seeded (mulberry32, seed 42), so every run produces identical data. It is generated in the browser for dashboards and regenerated on the server for investigations, so the dataset itself never needs to be uploaded.

| Property | Value |
|---|---|
| Dataset id | `synthetic-stockschool-v1` |
| Period | 120 days ending 2026-10-20 (UTC) |
| New users | ~60 per day (weekends ×0.8) → 6,709 users |
| Events | 119,438 rows (including planted duplicates) |
| Download | Data page → "Download CSV" |

## Fields

`user_id, event_name, timestamp, platform, acquisition_channel, course_category, session_id, revenue`

Events: `registration`, `onboarding_completed`, `app_open`, `lesson_completed`, `course_viewed`, `payment_initiated`, `purchase_completed`.
Course prices (revenue): stock_basics $29, technical_analysis $49, options_trading $79, personal_finance $19, crypto $59.

## Behaviour model

- **Mix:** platform Android 45% / iOS 35% / Web 20%; channel organic 50% / paid 35% / referral 15%; preferred category weighted towards stock_basics.
- **Onboarding:** completion rate is 72% on iOS, 64% on Android and 52% on Web, with paid users 8 points lower.
- **Engagement:** daily return probability decays exponentially from registration. Onboarding completers decay more slowly (τ = 14 vs 6 days) and keep a higher floor. Referral users retain best and paid users worst.
- **Purchase intent:** the first course view has a 40% base chance of starting checkout, adjusted for channel, category (crypto higher), platform (web lower) and onboarding. Payment completion is about 77–80%.

## Planted signals (what an investigation should find)

1. **Android payment regression.** In the final 7 days, Android `payment_initiated → purchase_completed` drops to 40% (from about 75%). iOS and Web are unchanged. This is the case the flagship question ("why did purchase conversion decline over the last seven days?") should recover. The demo agent finds 74.5% → 43.0%, p < 0.001.
2. **Onboarding–retention correlation.** Onboarding completers have a much higher Day-30 retention (~18%) than non-completers (~3%). This difference is *by construction correlational*: the generator ties engagement to the same draw.
3. **Channel quality.** Referral users retain best and paid users worst. Paid users also convert worse.

## Planted data-quality issues

- 0.4% exact duplicate events (removed by every calculation and reported by `validate_event_data`).
- 0.5% of events have no `session_id`.

## Other generator options

`generateSyntheticEvents({ seed, days, usersPerDay, endDate, injectAndroidPaymentRegression, duplicateRate })`. The evaluation suite uses `injectAndroidPaymentRegression: false` to check that the agent does not "find" a decline that isn't there.

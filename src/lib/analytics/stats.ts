/** Small, dependency-free statistics helpers used by the analytics tools. */

export const MIN_SAMPLE = 30;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |err| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** 95% Wilson score interval for a proportion. Null when n = 0. */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

export interface ProportionTest {
  z: number;
  pValue: number;
  significant: boolean;
}

/** Two-sided pooled two-proportion z-test. Null when either n is 0 or the pooled variance is 0. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number, alpha = 0.05): ProportionTest | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = (x1 / n1 - x2 / n2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue, significant: pValue < alpha };
}

/**
 * Per-arm sample size for a two-sided two-proportion test
 * (alpha = 0.05, power = 0.8) to detect an absolute lift of `mde`.
 */
export function sampleSizePerArm(baseline: number, mde: number): number | null {
  if (!(baseline > 0 && baseline < 1) || !(mde > 0)) return null;
  const p2 = Math.min(0.999, baseline + mde);
  const za = 1.959964;
  const zb = 0.841621;
  const pBar = (baseline + p2) / 2;
  const num = za * Math.sqrt(2 * pBar * (1 - pBar)) + zb * Math.sqrt(baseline * (1 - baseline) + p2 * (1 - p2));
  return Math.ceil((num * num) / (mde * mde));
}

"use client";

import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export const fmtPct = (x: number | null | undefined, dp = 1) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(dp)}%`);
export const fmtNum = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toLocaleString("en-US"));
export const fmtMoney = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const label = (s: string) => s.replace(/_/g, " ");

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label: l, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="text-xs font-medium text-muted">{l}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</div>
      {sub && <div className={cx("mt-1 text-xs", tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink-2")}>{sub}</div>}
    </div>
  );
}

const BADGE = {
  neutral: "bg-surface-2 text-ink-2",
  accent: "bg-accent-soft text-accent",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
};
export function Badge({ tone = "neutral", children }: { tone?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium", BADGE[tone])}>{children}</span>;
}

export function Button({ variant = "secondary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-ink text-white hover:bg-ink/90",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2",
        className,
      )}
    />
  );
}

export function Select({ label: l, className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className={cx("flex flex-col gap-1 text-xs text-muted", className)}>
      {l}
      <select {...p} className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent">
        {children}
      </select>
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <div className="text-sm font-medium text-ink">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function Loading({ label: l = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
      {l}
    </div>
  );
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "bad" | "good" | "accent"; children: ReactNode }) {
  const cls = { warn: "border-warn/20 bg-warn-soft text-warn", bad: "border-bad/20 bg-bad-soft text-bad", good: "border-good/20 bg-good-soft text-good", accent: "border-accent/20 bg-accent-soft text-accent" }[tone];
  return <div className={cx("rounded-lg border px-3.5 py-2.5 text-sm", cls)}>{children}</div>;
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-3 space-y-1">
      {items.map((w, i) => (
        <li key={i} className="flex gap-2 text-xs text-warn">
          <span aria-hidden>⚠</span>
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}

export function downloadText(filename: string, text: string, type = "text/markdown") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

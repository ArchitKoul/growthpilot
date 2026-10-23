"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useData } from "./data-context";
import { Badge, cx } from "./ui";

const NAV = [
  { href: "/", label: "Overview", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { href: "/investigate", label: "Investigate", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5" },
  { href: "/funnel", label: "Funnel", icon: "M3 4h18l-7 8v6l-4 2v-8z" },
  { href: "/retention", label: "Retention", icon: "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM4 16h4v4H4z" },
  { href: "/segments", label: "Segments", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { href: "/experiments", label: "Experiments", icon: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" },
  { href: "/briefs", label: "Product briefs", icon: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8" },
  { href: "/data", label: "Data", icon: "M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0zM4 6c0 2 16 2 16 0M4 12c0 2 16 2 16 0" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { active, status } = useData();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const on = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={() => setOpen(false)}
            className={cx("flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm", on ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-2/70 hover:text-ink")}
          >
            <Icon d={n.icon} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="space-y-2 border-t border-line pt-3 text-xs">
      <div className="text-muted">Active dataset</div>
      <div className="font-medium text-ink">{active ? active.meta.name : "Loading…"}</div>
      <div className="flex flex-wrap gap-1">
        {active && <Badge tone={active.meta.source === "synthetic" ? "accent" : "neutral"}>{active.meta.source === "synthetic" ? "Synthetic" : "Uploaded"}</Badge>}
        {status && <Badge tone={status.liveAvailable ? "good" : "warn"}>{status.liveAvailable ? "Live AI" : "Demo mode"}</Badge>}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-line bg-surface px-3 py-4 lg:sticky lg:top-0 lg:flex lg:h-screen">
        <div>
          <Link href="/" className="mb-5 flex items-center gap-2 px-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-xs font-bold text-white">GP</span>
            <span className="text-[15px] font-semibold tracking-tight">GrowthPilot</span>
          </Link>
          {nav}
        </div>
        {footer}
      </aside>

      <div className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-xs font-bold text-white">GP</span>
          <span className="font-semibold">GrowthPilot</span>
        </Link>
        <button className="rounded-lg border border-line px-2.5 py-1 text-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Menu
        </button>
      </div>
      {open && (
        <div className="border-b border-line bg-surface px-4 py-3 lg:hidden">
          {nav}
          <div className="mt-3">{footer}</div>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

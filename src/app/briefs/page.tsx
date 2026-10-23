"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useExperiments } from "@/components/use-experiments";
import { Button, Card, Empty, Notice, PageHeader, Select, downloadText } from "@/components/ui";
import { generateBrief } from "@/lib/analytics/brief";

/** Inline **bold** and `code` only — the brief generator emits nothing else inline. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-surface-2 px-1 text-[13px]">{part.slice(1, -1)}</code>;
    return part;
  });
}

function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`} className="my-2 list-disc space-y-1 pl-5">{list}</ul>);
    list = [];
  };
  source.split("\n").forEach((line, i) => {
    if (line.startsWith("- ")) {
      const t = line.slice(2);
      list.push(<li key={i}>{t.startsWith("[ ] ") ? <>☐ {inline(t.slice(4))}</> : inline(t)}</li>);
      return;
    }
    flush();
    if (line.startsWith("# ")) blocks.push(<h1 key={i} className="mb-2 text-xl font-semibold">{inline(line.slice(2))}</h1>);
    else if (line.startsWith("## ")) blocks.push(<h2 key={i} className="mt-6 mb-1 text-base font-semibold">{inline(line.slice(3))}</h2>);
    else if (line.startsWith("> ")) blocks.push(<blockquote key={i} className="my-2 border-l-2 border-line pl-3 text-ink-2">{inline(line.slice(2))}</blockquote>);
    else if (line.startsWith("_") && line.endsWith("_")) blocks.push(<p key={i} className="text-xs text-muted">{line.slice(1, -1).replace(/`/g, "")}</p>);
    else if (line.trim()) blocks.push(<p key={i} className="my-1.5">{inline(line)}</p>);
  });
  flush();
  return <div className="text-sm leading-relaxed text-ink">{blocks}</div>;
}

export default function BriefsPage() {
  const entries = useExperiments();
  const [picked, setPicked] = useState<string>("");
  // preselect from ?exp=&inv= (linked from the experiments page)
  const [fromUrl] = useState(() => {
    if (typeof window === "undefined") return "";
    const p = new URLSearchParams(window.location.search);
    return p.get("inv") && p.get("exp") ? `${p.get("inv")}::${p.get("exp")}` : "";
  });
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  const keyOf = (e: (typeof entries)[number]) => `${e.investigation.id}::${e.exp.id}`;

  const entry =
    entries.find((e) => keyOf(e) === picked) ?? entries.find((e) => keyOf(e) === fromUrl) ?? entries[0] ?? null;
  const selected = entry ? keyOf(entry) : "";
  const md = useMemo(
    () =>
      entry
        ? generateBrief(entry.exp, {
            datasetId: entry.investigation.dataset.id,
            datasetName: entry.investigation.dataset.name,
            investigationQuestion: entry.investigation.question,
            generatedAt: new Date(entry.investigation.started_at).toISOString().slice(0, 10),
          })
        : "",
    [entry],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(md);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied("idle"), 2000);
  }

  return (
    <>
      <PageHeader title="Product briefs" description="Turn an experiment recommendation into a product brief you can share. Copy it or export it as Markdown." />
      {entries.length === 0 ? (
        <Empty title="No experiments to brief yet">
          Briefs are generated from experiment recommendations. <Link href="/investigate" className="text-accent">Run an investigation →</Link>
        </Empty>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Select label="Experiment" value={selected} onChange={(e) => setPicked(e.target.value)} className="min-w-0 max-w-full sm:min-w-[420px]">
              {entries.map((e) => (
                <option key={keyOf(e)} value={keyOf(e)}>
                  {e.exp.title.slice(0, 80)} — {e.investigation.dataset.name}
                </option>
              ))}
            </Select>
            <div className="flex gap-2">
              <Button onClick={copy} disabled={!md}>{copied === "ok" ? "Copied ✓" : copied === "fail" ? "Copy failed" : "Copy Markdown"}</Button>
              <Button variant="primary" disabled={!md} onClick={() => entry && downloadText(`brief-${entry.exp.id}.md`, md)}>
                Download .md
              </Button>
            </div>
          </div>
          {entry?.investigation.mode === "demo" && (
            <Notice tone="warn">This brief comes from a demo-mode investigation: its findings were produced by the rule-based planner, not Claude.</Notice>
          )}
          <Card>{md ? <Markdown source={md} /> : <Empty title="Select an experiment" />}</Card>
        </div>
      )}
    </>
  );
}

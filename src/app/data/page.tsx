"use client";

import { useMemo, useState } from "react";
import { useData } from "@/components/data-context";
import { Badge, Button, Card, Notice, PageHeader, cx, downloadText, fmtNum } from "@/components/ui";
import { ALL_FIELDS, MAX_UPLOAD_BYTES, REQUIRED_FIELDS, importCsv, parseCsv, suggestMapping, toCsv, type ColumnMapping, type CsvImportResult } from "@/lib/analytics/csv";
import { validateEvents, type QualityReport } from "@/lib/analytics/quality";
import { CATEGORIES, CHANNELS, EVENT_NAMES, PLATFORMS } from "@/lib/analytics/schema";

const MAX_AGENT_EVENTS = 60_000; // mirrors the server-side limit for uploaded datasets

const SCHEMA_ROWS: [string, string, string][] = [
  ["user_id", "required", "Stable user identifier (≤128 chars)."],
  ["event_name", "required", EVENT_NAMES.join(", ")],
  ["timestamp", "required", "ISO 8601 (2026-10-20T14:03:00Z), YYYY-MM-DD, or Unix seconds/milliseconds. Ambiguous formats are rejected."],
  ["platform", "required", PLATFORMS.join(", ")],
  ["acquisition_channel", "required", CHANNELS.join(", ")],
  ["course_category", "optional", CATEGORIES.join(", ")],
  ["session_id", "optional", "Session identifier."],
  ["revenue", "optional", "Non-negative number; expected on purchase_completed."],
];

function QualityPanel({ report }: { report: QualityReport }) {
  const tone = report.status === "pass" ? "good" : report.status === "warnings" ? "warn" : "bad";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={tone}>{report.status === "pass" ? "All checks passed" : report.status === "warnings" ? "Warnings" : "Errors"}</Badge>
        <span className="text-ink-2">
          {fmtNum(report.total_events)} events · {fmtNum(report.unique_users)} users · {report.first_event?.slice(0, 10)} → {report.last_event?.slice(0, 10)}
        </span>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {report.checks.map((c) => (
          <li key={c.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-sm font-medium text-ink">{c.label}</div>
              <div className="text-xs text-ink-2">{c.detail}</div>
              {c.examples.length > 0 && c.severity !== "info" && <div className="mt-0.5 font-mono text-[11px] text-muted">e.g. {c.examples.slice(0, 3).join(" · ")}</div>}
            </div>
            <Badge tone={c.severity === "info" ? "good" : c.severity === "warning" ? "warn" : "bad"}>{c.severity === "info" ? "ok" : `${fmtNum(c.count)} ${c.severity}`}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DataPage() {
  const { datasets, active, setActiveId, addDataset, removeDataset } = useData();
  const [file, setFile] = useState<{ name: string; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [name, setName] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imported, setImported] = useState<CsvImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const activeReport = useMemo(() => (active ? validateEvents(active.meta.id, active.events) : null), [active]);

  async function onFile(f: File | undefined) {
    setUploadError(null);
    setImported(null);
    setFile(null);
    if (!f) return;
    if (!/\.csv$/i.test(f.name) || (f.type && !/csv|text\/plain|excel/.test(f.type))) return setUploadError("Only .csv files are accepted.");
    if (f.size > MAX_UPLOAD_BYTES) return setUploadError(`File is ${(f.size / 1e6).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1e6} MB.`);
    if (f.size === 0) return setUploadError("The file is empty.");
    setBusy(true);
    try {
      const rows = parseCsv(await f.text());
      if (rows.length < 2) throw new Error("The file needs a header row and at least one data row.");
      setFile({ name: f.name, rows });
      setMapping(suggestMapping(rows[0]));
      setName(f.name.replace(/\.csv$/i, ""));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setBusy(false);
    }
  }

  function doImport() {
    if (!file || !mapping) return;
    const res = importCsv(file.rows, mapping);
    setImported(res);
    if (res.missingRequired.length) return;
    if (res.events.length === 0) return setUploadError("No valid rows were found. See the row errors below.");
    if (res.events.length > MAX_AGENT_EVENTS) return setUploadError(`${fmtNum(res.events.length)} valid events exceeds the ${fmtNum(MAX_AGENT_EVENTS)}-event limit for uploaded datasets.`);
    const slug = (name || "upload").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    addDataset({
      meta: { id: `upload-${slug}-${Date.now().toString(36)}`, name: name || file.name, source: "upload", createdAt: new Date().toISOString(), rowCount: res.events.length },
      events: res.events,
    });
    setFile(null);
    setMapping(null);
  }

  const missing = mapping ? REQUIRED_FIELDS.filter((f) => !mapping[f]) : [];

  return (
    <>
      <PageHeader title="Data management" description="Choose the dataset to analyse, import your own events from CSV, and review data quality. Datasets are never combined." />

      <div className="space-y-6">
        <Card title="Datasets" subtitle="Analyses always run on exactly one active dataset">
          <ul className="divide-y divide-line">
            {datasets.map((d) => (
              <li key={d.meta.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-ink">
                    {d.meta.name}
                    <Badge tone={d.meta.source === "synthetic" ? "accent" : "neutral"}>{d.meta.source}</Badge>
                    {active?.meta.id === d.meta.id && <Badge tone="good">active</Badge>}
                  </div>
                  <div className="font-mono text-xs text-muted">{d.meta.id} · {fmtNum(d.meta.rowCount)} rows</div>
                </div>
                <div className="flex gap-2">
                  {active?.meta.id !== d.meta.id && <Button onClick={() => setActiveId(d.meta.id)}>Analyse this</Button>}
                  {d.meta.source === "synthetic" ? (
                    <Button variant="ghost" onClick={() => downloadText("stockschool-synthetic-events.csv", toCsv(d.events), "text/csv")}>Download CSV</Button>
                  ) : (
                    <Button variant="ghost" onClick={() => confirm(`Remove "${d.meta.name}" from this session?`) && removeDataset(d.meta.id)}>Remove</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Uploaded datasets live in this browser tab only. They are sent to the server only with an investigation request, validated, and never stored.</p>
        </Card>

        <Card title="Import CSV" subtitle={`.csv only · max ${MAX_UPLOAD_BYTES / 1e6} MB · max ${fmtNum(MAX_AGENT_EVENTS)} events`}>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-surface-2"
          />
          {busy && <p className="mt-2 text-sm text-muted">Reading file…</p>}
          {uploadError && <div className="mt-3"><Notice tone="bad">{uploadError}</Notice></div>}

          {file && mapping && (
            <div className="mt-5 space-y-5">
              <div>
                <h3 className="mb-2 text-sm font-semibold">1. Map columns</h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {ALL_FIELDS.map((f) => (
                    <label key={f} className="flex flex-col gap-1 text-xs text-muted">
                      <span>
                        {f} {(REQUIRED_FIELDS as readonly string[]).includes(f) && <span className="text-bad">*</span>}
                      </span>
                      <select
                        value={mapping[f]}
                        onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}
                        className={cx("rounded-lg border bg-surface px-2 py-1.5 text-sm text-ink", !mapping[f] && (REQUIRED_FIELDS as readonly string[]).includes(f) ? "border-bad" : "border-line")}
                      >
                        <option value="">— not mapped —</option>
                        {file.rows[0].map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">2. Preview ({fmtNum(file.rows.length - 1)} rows in file)</h3>
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-2 text-left text-muted">
                      <tr>{file.rows[0].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-line font-mono">
                      {file.rows.slice(1, 9).map((r, i) => (
                        <tr key={i}>{file.rows[0].map((_, j) => <td key={j} className="whitespace-nowrap px-2 py-1">{r[j] ?? ""}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs text-muted">
                  Dataset name
                  <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink" />
                </label>
                <Button variant="primary" onClick={doImport} disabled={missing.length > 0}>
                  3. Validate & import
                </Button>
                {missing.length > 0 && <span className="text-xs text-bad">Map required fields: {missing.join(", ")}</span>}
              </div>
            </div>
          )}

          {imported && (
            <div className="mt-4 space-y-2">
              {imported.missingRequired.length > 0 && <Notice tone="bad">Missing required columns: {imported.missingRequired.join(", ")}</Notice>}
              {imported.events.length > 0 && imported.missingRequired.length === 0 && !uploadError && (
                <Notice tone="good">Imported {fmtNum(imported.events.length)} of {fmtNum(imported.totalRows)} rows. The new dataset is now active.</Notice>
              )}
              {imported.errors.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-warn">{fmtNum(imported.errors.length)} rows rejected (showing first 10):</div>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ink-2">
                    {imported.errors.slice(0, 10).map((e, i) => <li key={i}>row {e.row}: {e.message}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="Data quality — active dataset" subtitle={active?.meta.name}>
          {activeReport ? <QualityPanel report={activeReport} /> : <p className="text-sm text-muted">Loading…</p>}
        </Card>

        <Card title="Event schema">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <tbody className="divide-y divide-line">
                {SCHEMA_ROWS.map(([f, req, d]) => (
                  <tr key={f}>
                    <td className="py-2 pr-4 font-mono text-xs">{f}</td>
                    <td className="py-2 pr-4"><Badge tone={req === "required" ? "accent" : "neutral"}>{req}</Badge></td>
                    <td className="py-2 text-ink-2">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

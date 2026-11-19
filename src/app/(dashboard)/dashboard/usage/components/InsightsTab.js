"use client";

import { useState, useEffect, useMemo, Fragment } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { cn } from "@/shared/utils/cn";

const EMPTY_FILTERS = { combo: "", member: "", status: "", trace: "", tag: "" };
const TH = "p-3 text-xs font-semibold uppercase text-text-muted";
const TD = "p-3 text-sm text-text-main";
const ROW = "border-b border-black/5 dark:border-white/5 last:border-b-0";
const SELECT = cn(
  "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
  "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
  "w-full min-w-0 cursor-pointer"
);

const fmtInt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtPct = (n) => `${((n || 0) * 100).toFixed(1)}%`;

function fmtMs(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

// Loads JSON from a URL. `loading` is true until the current URL has answered.
function useJson(url, errorMessage) {
  const [result, setResult] = useState({ url: null, data: null, error: "" });

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Request failed"))))
      .then((data) => setResult({ url, data, error: "" }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setResult({ url, data: null, error: errorMessage });
      });
    return () => controller.abort();
  }, [url, errorMessage]);

  const current = result.url === url;
  return { data: result.data, loading: !current, error: current ? result.error : "" };
}

function Spinner() {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-text-muted">
      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
      Loading...
    </div>
  );
}

function FilterSelect({ id, label, value, onChange, allLabel, options }) {
  // The option lists hold only the most common values. Keep the active value
  // selectable, or the select would show "All" while the rows stay filtered.
  const shown = value && !options.some((option) => option.value === value) ? [{ value }, ...options] : options;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-text-main">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT} style={{ colorScheme: "auto" }}>
        <option value="">{allLabel}</option>
        {shown.map((option) => (
          <option key={option.value} value={option.value}>{option.label || option.value}</option>
        ))}
      </select>
    </div>
  );
}

FilterSelect.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  allLabel: PropTypes.string.isRequired,
  options: PropTypes.array.isRequired,
};

function LatencyCard({ latency }) {
  const [groupBy, setGroupBy] = useState("model");
  const rows = groupBy === "model" ? latency.byModel : latency.byComboMember;

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-semibold text-text-main">Latency</h3>
          <p className="text-xs text-text-muted">
            {fmtInt(latency.withLatency)} of {fmtInt(latency.okRows)} served requests have latency data.{" "}
            {fmtInt(latency.withTtft)} have a time to first token (streaming only).
          </p>
          <p className="text-xs text-text-muted">
            Times are per upstream attempt: from when 9Router called the model that served the request, without earlier combo members or retries.
            {latency.withLatency > latency.attemptScoped && (
              <> {fmtInt(latency.withLatency - latency.attemptScoped)} older requests are timed from the start of the client request instead.</>
            )}
          </p>
        </div>
        <SegmentedControl
          options={[
            { value: "model", label: "Provider / model" },
            { value: "combo", label: "Combo member" },
          ]}
          value={groupBy}
          onChange={setGroupBy}
          size="sm"
        />
      </div>
      <div className="overflow-x-auto border-t border-black/5 dark:border-white/5">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr className={ROW}>
              {groupBy === "combo" && <th className={cn(TH, "text-left")}>Combo</th>}
              <th className={cn(TH, "text-left")}>{groupBy === "combo" ? "Member" : "Provider / model"}</th>
              <th className={cn(TH, "text-right")}>Requests</th>
              <th className={cn(TH, "text-right")}>TTFT p50</th>
              <th className={cn(TH, "text-right")}>TTFT p95</th>
              <th className={cn(TH, "text-right")}>Total p50</th>
              <th className={cn(TH, "text-right")}>Total p95</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={groupBy === "combo" ? 7 : 6} className="p-8 text-center text-sm text-text-muted">No latency data in this period.</td></tr>
            )}
            {rows.map((row) => (
              <tr key={groupBy === "combo" ? `${row.combo}|${row.member}` : `${row.provider}/${row.model}`} className={ROW}>
                {groupBy === "combo" && <td className={cn(TD, "max-w-[200px] truncate font-medium")}>{row.combo}</td>}
                <td className={cn(TD, "max-w-[320px] truncate font-mono")}>{groupBy === "combo" ? row.member : `${row.provider}/${row.model}`}</td>
                <td className={cn(TD, "text-right font-mono")}>{fmtInt(row.count)}</td>
                <td className={cn(TD, "text-right font-mono")}>{fmtMs(row.ttftP50)}</td>
                <td className={cn(TD, "text-right font-mono")}>{fmtMs(row.ttftP95)}</td>
                <td className={cn(TD, "text-right font-mono")}>{fmtMs(row.totalP50)}</td>
                <td className={cn(TD, "text-right font-mono")}>{fmtMs(row.totalP95)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

LatencyCard.propTypes = { latency: PropTypes.object.isRequired };

function ComboCard({ combos, onPick }) {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="p-4">
        <h3 className="font-semibold text-text-main">Combo fallbacks</h3>
        <p className="text-xs text-text-muted">
          Shows which member served each combo request and why other members failed. Click a member to filter the rows below.
          Requests from before this feature have no failure data.
        </p>
      </div>
      <div className="overflow-x-auto border-t border-black/5 dark:border-white/5">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr className={ROW}>
              <th className={cn(TH, "text-left")}>Combo / member</th>
              <th className={cn(TH, "text-right")}>Served</th>
              <th className={cn(TH, "text-right")}>Rate limit</th>
              <th className={cn(TH, "text-right")}>Timeout</th>
              <th className={cn(TH, "text-right")}>Empty</th>
              <th className={cn(TH, "text-right")}>Other error</th>
              <th className={cn(TH, "text-left")}>Error codes</th>
              <th className={cn(TH, "text-right")}>Fallback rate</th>
            </tr>
          </thead>
          <tbody>
            {combos.length === 0 && (
              <tr><td colSpan={8} className="p-8 text-center text-sm text-text-muted">No combo requests in this period.</td></tr>
            )}
            {combos.map((combo) => (
              <Fragment key={combo.combo}>
                <tr className={cn(ROW, "bg-black/[0.02] dark:bg-white/[0.02]")}>
                  <td className={cn(TD, "font-semibold")} colSpan={7}>
                    <button type="button" className="hover:underline" onClick={() => onPick(combo.combo, "")}>{combo.combo}</button>
                    <span className="ml-2 text-xs font-normal text-text-muted">
                      {fmtInt(combo.requests)} requests · {fmtInt(combo.fellBack)} served after a fallback · {fmtInt(combo.failed)} not served
                    </span>
                  </td>
                  <td className={cn(TD, "text-right font-mono font-semibold")}>{fmtPct(combo.fallbackRate)}</td>
                </tr>
                {combo.members.map((member) => (
                  <tr key={`${combo.combo}|${member.model}`} className={ROW}>
                    <td className={cn(TD, "max-w-[320px] truncate pl-6 font-mono")}>
                      <button type="button" className="hover:underline" onClick={() => onPick(combo.combo, member.model)}>{member.model}</button>
                    </td>
                    <td className={cn(TD, "text-right font-mono")}>{fmtInt(member.served)}</td>
                    <td className={cn(TD, "text-right font-mono")}>{fmtInt(member.reasons.rate_limit)}</td>
                    <td className={cn(TD, "text-right font-mono")}>{fmtInt(member.reasons.timeout)}</td>
                    <td className={cn(TD, "text-right font-mono")}>{fmtInt(member.reasons.empty)}</td>
                    <td className={cn(TD, "text-right font-mono")}>{fmtInt(member.reasons.error)}</td>
                    <td className={cn(TD, "whitespace-nowrap font-mono text-xs text-text-muted")}>
                      {member.codes.length ? member.codes.map((entry) => `${entry.code}×${entry.count}`).join("  ") : "—"}
                    </td>
                    <td className={cn(TD, "text-right font-mono")}>{fmtPct(member.fallbackRate)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

ComboCard.propTypes = { combos: PropTypes.array.isRequired, onPick: PropTypes.func.isRequired };

function RowsCard({ period, options, filters, setFilters }) {
  const url = useMemo(() => {
    const params = new URLSearchParams({ period });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return `/api/usage/insights/rows?${params.toString()}`;
  }, [period, filters]);
  const { data, loading, error } = useJson(url, "Could not load usage rows.");

  const members = useMemo(() => {
    const combos = filters.combo ? options.combos.filter((entry) => entry.value === filters.combo) : options.combos;
    return [...new Set(combos.flatMap((entry) => entry.members))].sort().map((value) => ({ value }));
  }, [options.combos, filters.combo]);

  const statusOptions = useMemo(() => [
    { value: "ok", label: "OK" },
    { value: "error", label: "Any error" },
    ...options.statuses.filter((entry) => entry.value !== "ok" && entry.value !== "error").map((entry) => ({ value: entry.value, label: `${entry.value} (${entry.count})` })),
  ], [options.statuses]);

  const set = (key) => (value) => setFilters((prev) => ({ ...prev, [key]: value, ...(key === "combo" ? { member: "" } : {}) }));
  const hasFilter = Object.values(filters).some(Boolean);
  const rows = data?.rows || [];

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-semibold text-text-main">Requests</h3>
            <p className="text-xs text-text-muted">TTFT and Total are per upstream attempt. A value marked * is timed from the start of the client request (older rows and failures).</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)} disabled={!hasFilter}>Clear filters</Button>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <FilterSelect id="insight-combo" label="Combo" value={filters.combo} onChange={set("combo")} allLabel="All combos" options={options.combos} />
          <FilterSelect id="insight-member" label="Combo member" value={filters.member} onChange={set("member")} allLabel="All members" options={members} />
          <FilterSelect id="insight-status" label="Status" value={filters.status} onChange={set("status")} allLabel="All statuses" options={statusOptions} />
          <FilterSelect id="insight-trace" label="Trace" value={filters.trace} onChange={set("trace")} allLabel="All traces" options={options.traces} />
          <FilterSelect id="insight-tag" label="Tag" value={filters.tag} onChange={set("tag")} allLabel="All tags" options={options.tags} />
        </div>
      </div>
      <div className="overflow-x-auto border-t border-black/5 dark:border-white/5">
        <table className="w-full min-w-[1040px]">
          <thead>
            <tr className={ROW}>
              <th className={cn(TH, "text-left")}>Time</th>
              <th className={cn(TH, "text-left")}>Provider / model</th>
              <th className={cn(TH, "text-left")}>Combo</th>
              <th className={cn(TH, "text-left")}>Status</th>
              <th className={cn(TH, "text-left")}>Failed first</th>
              <th className={cn(TH, "text-left")}>Trace / tags</th>
              <th className={cn(TH, "text-right")}>TTFT</th>
              <th className={cn(TH, "text-right")}>Total</th>
              <th className={cn(TH, "text-right")}>Tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9}><Spinner /></td></tr>}
            {!loading && error && <tr><td colSpan={9} className="p-8 text-center text-sm text-text-muted">{error}</td></tr>}
            {!loading && !error && rows.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-sm text-text-muted">No requests match these filters.</td></tr>
            )}
            {!loading && !error && rows.map((row) => (
              <tr key={row.id} className={cn(ROW, "hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors")}>
                <td className={cn(TD, "whitespace-nowrap")}>{new Date(row.timestamp).toLocaleString()}</td>
                <td className={cn(TD, "max-w-[260px] truncate font-mono")}>{row.provider}/{row.model}</td>
                <td className={cn(TD, "max-w-[160px] truncate")}>{row.combo || "—"}</td>
                <td className={TD}>
                  <Badge variant={row.status === "ok" ? "success" : "error"} size="sm">{row.status === "ok" ? "OK" : row.status}</Badge>
                  {row.errorKind && <span className="ml-2 text-xs text-text-muted">{row.errorKind}</span>}
                  {row.emptyFinal && <span className="ml-2 text-xs text-text-muted">empty answer</span>}
                </td>
                <td className={cn(TD, "max-w-[280px] font-mono text-xs text-text-muted")}>
                  {row.attempts.length
                    ? row.attempts.map((attempt, index) => (
                        <div key={`${attempt.model}-${index}`} className="truncate">
                          {attempt.model} · {attempt.reason}{attempt.status ? ` ${attempt.status}` : ""}
                        </div>
                      ))
                    : "—"}
                </td>
                <td className={cn(TD, "max-w-[240px]")}>
                  {!row.trace && row.tags.length === 0 && "—"}
                  {row.trace && (
                    <button type="button" className="block max-w-full truncate text-left font-medium hover:underline" onClick={() => set("trace")(row.trace)}>
                      {row.trace}
                    </button>
                  )}
                  {row.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.tags.map((tag) => (
                        <button key={tag} type="button" onClick={() => set("tag")(tag)}>
                          <Badge size="sm">{tag}</Badge>
                        </button>
                      ))}
                    </div>
                  )}
                </td>
                <td className={cn(TD, "text-right font-mono")}>{fmtMs(row.ttftMs)}{row.ttftMs != null && row.latencyScope === "request" ? "*" : ""}</td>
                <td className={cn(TD, "text-right font-mono")}>{fmtMs(row.totalMs)}{row.totalMs != null && row.latencyScope === "request" ? "*" : ""}</td>
                <td className={cn(TD, "whitespace-nowrap text-right font-mono")}>{fmtInt(row.promptTokens)} / {fmtInt(row.completionTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && data?.hasMore && (
        <p className="border-t border-black/5 p-3 text-center text-xs text-text-muted dark:border-white/5">
          Showing the newest {fmtInt(data.limit)} requests. Add a filter or pick a shorter period to see more.
        </p>
      )}
      {!loading && !error && data?.capped && hasFilter && (
        <p className="border-t border-black/5 p-3 text-center text-xs text-text-muted dark:border-white/5">
          Filters searched the latest {fmtInt(data.cap)} requests of this period. Pick a shorter period to search older ones.
        </p>
      )}
    </Card>
  );
}

RowsCard.propTypes = {
  period: PropTypes.string.isRequired,
  options: PropTypes.object.isRequired,
  filters: PropTypes.object.isRequired,
  setFilters: PropTypes.func.isRequired,
};

const EMPTY_OPTIONS = { combos: [], statuses: [], traces: [], tags: [] };

export default function InsightsTab({ period }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const { data: summary, loading, error } = useJson(`/api/usage/insights?period=${encodeURIComponent(period)}`, "Could not load insights.");

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {loading && <Card padding="md"><Spinner /></Card>}
      {error && <Card padding="md"><p className="text-center text-sm text-text-muted">{error}</p></Card>}
      {summary && (
        // While another period loads, the previous summary stays but is dimmed.
        <div className={cn("flex min-w-0 flex-col gap-6 transition-opacity", loading && "pointer-events-none opacity-50")} aria-busy={loading}>
          {summary.sampled.capped && (
            <p className="text-xs text-text-muted">
              This period has many requests. The summaries use the newest {fmtInt(summary.sampled.cap)}.
            </p>
          )}
          <LatencyCard latency={summary.latency} />
          <ComboCard combos={summary.combos} onPick={(combo, member) => setFilters((prev) => ({ ...prev, combo, member }))} />
        </div>
      )}
      <RowsCard period={period} options={summary?.options || EMPTY_OPTIONS} filters={filters} setFilters={setFilters} />
    </div>
  );
}

InsightsTab.propTypes = { period: PropTypes.string.isRequired };

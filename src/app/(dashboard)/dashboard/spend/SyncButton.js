"use client";
// Page-level sync control: "Sync now" plus an auto-sync interval with a countdown.
// The seconds left come from the countdown store of useAutoSync, read here and nowhere else, so the
// one-per-second update re-renders the two small parts below and not the page.
import { useSyncExternalStore } from "react";
import { SYNC_CHOICES, syncLabel } from "@/lib/dashboardSync";

const BOX = { display: "inline-flex", alignItems: "stretch", height: 28, borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", overflow: "hidden", fontSize: 12, whiteSpace: "nowrap" };
const BTN = { display: "inline-flex", alignItems: "center", gap: 5, padding: "0 10px", border: 0, background: "transparent", color: "var(--tx)", font: "inherit", fontSize: 12 };
const noSubscribe = () => () => {};
const zero = () => 0;

// A caller without the store (a plain `left` number) still works: the value then changes only when it re-renders.
function useLeft(sync) {
  const fixed = sync?.left ?? 0;
  return useSyncExternalStore(sync?.subscribe || noSubscribe, sync?.getLeft || (() => fixed), zero);
}
function TimeLeft({ sync }) {
  const left = useLeft(sync);
  return <span style={{ color: "var(--tx3)", fontVariantNumeric: "tabular-nums", minWidth: 30, textAlign: "right" }} aria-label={`next sync in ${left} seconds`}>{left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${left}s`}</span>;
}
function TimeBar({ sync, seconds }) {
  const left = useLeft(sync);
  const pct = seconds ? Math.max(0, Math.min(1, left / seconds)) : 0;
  return <span aria-hidden="true" style={{ position: "absolute", left: 0, bottom: 0, height: 2, width: `${pct * 100}%`, background: "var(--acc)", opacity: 0.7, transition: "width 1s linear" }} />;
}

export default function SyncButton({ sync, busy = false }) {
  const { seconds = 0, syncNow, setSeconds, saving } = sync || {};
  return (
    <span style={{ ...BOX, position: "relative" }}>
      <button type="button" onClick={() => syncNow?.(sync?.manual)} disabled={busy} aria-busy={busy || undefined} title="Load the latest data now and restart the timer" style={{ ...BTN, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
        <span aria-hidden="true" className={busy ? "r9-sync-spin" : undefined} style={{ fontFamily: "'Material Symbols Outlined'", fontSize: 15, lineHeight: 1 }}>sync</span>
        Sync now
        {seconds > 0 && <TimeLeft sync={sync} />}
      </button>
      <label style={{ display: "inline-flex", alignItems: "center", borderLeft: "1px solid var(--line2)", padding: "0 4px 0 8px", color: "var(--tx2)", gap: 4 }} title="Auto-sync interval, saved on the server">
        <span className="r9-sync-auto-label">Auto</span>
        <select value={seconds} disabled={saving} onChange={(e) => setSeconds(Number(e.target.value))} aria-label="Auto-sync interval" style={{ border: 0, background: "transparent", color: "var(--tx)", font: "inherit", fontSize: 12, cursor: "pointer", padding: "0 2px" }}>
          {SYNC_CHOICES.map((s) => <option key={s} value={s}>{syncLabel(s)}</option>)}
        </select>
      </label>
      {seconds > 0 && <TimeBar sync={sync} seconds={seconds} />}
    </span>
  );
}

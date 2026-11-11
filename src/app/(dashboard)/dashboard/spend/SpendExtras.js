"use client";

import { useState } from "react";
import { estimateMove } from "@/lib/spend/whatIf";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const money = (n) => `$${n.toFixed(4)}`;

export default function SpendExtras({ data }) {
  const [metric, setMetric] = useState("cost");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const cells = new Map((data.clock || []).map((c) => [`${c.weekday}:${c.hour}`, c]));
  const max = Math.max(0, ...(data.clock || []).map((c) => Number(c[metric]) || 0));
  const groups = data.whatIfGroups || [];
  const selected = groups.find((g) => JSON.stringify([g.kind, g.name]) === source);
  const options = (data.whatIfTargets || []).map((t) => ({ id: JSON.stringify([t.provider, t.model]), name: `${t.provider} / ${t.model}`, p: t.price }));
  const price = options.find((o) => o.id === target)?.p;
  const estimate = selected && price ? estimateMove(selected, price) : null;
  return <>
    <section className="r9-extra-card" aria-labelledby="clock-title">
      <div className="r9-extra-heading"><div><h2 id="clock-title">Spending clock</h2><p>List-price cost by weekday and hour in IST</p></div><label>Show <select value={metric} onChange={(e) => setMetric(e.target.value)}><option value="cost">Cost</option><option value="req">Requests</option></select></label></div>
      <div className="r9-clock-scroll"><table className="r9-clock"><thead><tr><th scope="col">IST</th>{Array.from({ length: 24 }, (_, h) => <th scope="col" key={h}>{String(h).padStart(2, "0")}</th>)}</tr></thead><tbody>{days.map((day, d) => <tr key={day}><th scope="row">{day}</th>{Array.from({ length: 24 }, (_, h) => { const value = Number(cells.get(`${d}:${h}`)?.[metric]) || 0; const title = `${day} ${String(h).padStart(2, "0")}:00 IST: ${metric === "cost" ? money(value) : `${value} requests`}`; return <td key={h} title={title} aria-label={title} style={{ background: value && max ? `color-mix(in srgb, var(--blue) ${Math.max(12, Math.round(value / max * 85))}%, var(--card))` : "var(--seg)" }} />; })}</tr>)}</tbody></table></div>
    </section>
    <section className="r9-extra-card" aria-labelledby="whatif-title"><div className="r9-extra-heading"><div><h2 id="whatif-title">What-if combo move</h2><p>Estimate using recorded tokens and target list prices. No routing changes.</p></div></div>
      <div className="r9-extra-controls"><label>Source combo or model <select value={source} onChange={(e) => setSource(e.target.value)}><option value="">Select source</option>{groups.map((g) => { const id = JSON.stringify([g.kind, g.name]); return <option key={id} value={id}>{g.kind}: {g.name}</option>; })}</select></label><label>Target model <select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Select target</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label></div>
      {options.length === 0 && <p>No priced models in the last 60 days. Free and subscription-only models have no list price.</p>}
      {estimate && <p aria-live="polite"><strong>Estimate: {money(estimate.cost)}</strong> for {selected.req} requests · recorded list cost {money(selected.cost)} · delta {estimate.delta >= 0 ? "+" : "−"}{money(Math.abs(estimate.delta))}</p>}
    </section>
  </>;
}

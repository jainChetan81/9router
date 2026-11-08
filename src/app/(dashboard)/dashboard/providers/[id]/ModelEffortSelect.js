"use client";

import { useState } from "react";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getFixedEffortLevel, getModelEffortKey } from "open-sse/services/modelEffort.js";

const label = (value) => value.charAt(0).toUpperCase() + value.slice(1);

export default function ModelEffortSelect({ providerId, modelId, modelOverrides, providerDefaultEffort, onChange }) {
  const levels = getThinkingLevels(providerId, modelId);
  const fixed = getFixedEffortLevel(providerId, modelId);
  const key = getModelEffortKey(providerId, modelId);
  const savedEntry = modelOverrides?.[key];
  const savedEffort = savedEntry?.effort;
  const value = levels?.includes(savedEffort) ? savedEffort : "auto";
  const locked = value !== "auto" && savedEntry?.locked === true;
  const [saving, setSaving] = useState(false);

  if (!levels) return <span className="text-[10px] text-text-muted">Effort: Not supported</span>;
  if (fixed) return <span className="text-[10px] text-text-muted">Fixed: {label(fixed)}</span>;

  const handleChange = async (event) => {
    const effort = event.target.value;
    setSaving(true);
    try {
      await onChange(modelId, { effort, locked: effort === "auto" ? false : locked });
    } catch {
      // The provider page displays the save error and keeps the saved selection.
    } finally {
      setSaving(false);
    }
  };

  const handleLockChange = async (event) => {
    setSaving(true);
    try {
      await onChange(modelId, { effort: value, locked: event.target.checked });
    } catch {
      // The provider page displays the save error and keeps the saved selection.
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-text-muted">
      <label className="inline-flex items-center gap-1.5">
        <span>Effort</span>
        <select
          value={value}
          disabled={saving}
          onChange={handleChange}
          className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-text-main focus:border-primary focus:outline-none disabled:opacity-60"
          aria-label={`Effort for ${modelId}`}
        >
          <option value="auto">{providerDefaultEffort ? `Provider default (${label(providerDefaultEffort)})` : "Provider default"}</option>
          {levels.map((level) => <option key={level} value={level}>{label(level)}</option>)}
        </select>
      </label>
      <label className="inline-flex items-center gap-1" title="Override client effort and model suffixes">
        <input
          type="checkbox"
          checked={locked}
          disabled={saving || value === "auto"}
          onChange={handleLockChange}
          aria-label={`Lock effort for ${modelId}`}
          className="accent-primary disabled:opacity-60"
        />
        <span>Lock</span>
      </label>
    </span>
  );
}

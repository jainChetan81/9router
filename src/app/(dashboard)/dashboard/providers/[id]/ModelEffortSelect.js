"use client";

import { useState } from "react";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getFixedEffortLevel, getModelEffortKey } from "open-sse/services/modelEffort.js";

const label = (value) => value.charAt(0).toUpperCase() + value.slice(1);

export default function ModelEffortSelect({ providerId, modelId, modelOverrides, onChange }) {
  const levels = getThinkingLevels(providerId, modelId);
  const fixed = getFixedEffortLevel(providerId, modelId);
  const key = getModelEffortKey(providerId, modelId);
  const savedEffort = modelOverrides?.[key]?.effort;
  const value = levels?.includes(savedEffort) ? savedEffort : "auto";
  const [saving, setSaving] = useState(false);

  if (!levels) return <span className="text-[10px] text-text-muted">Effort: Not supported</span>;
  if (fixed) return <span className="text-[10px] text-text-muted">Fixed: {label(fixed)}</span>;

  const handleChange = async (event) => {
    setSaving(true);
    try {
      await onChange(modelId, event.target.value);
    } catch {
      // The provider page displays the save error and keeps the saved selection.
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="inline-flex items-center gap-1.5 text-[10px] text-text-muted">
      <span>Effort</span>
      <select
        value={value}
        disabled={saving}
        onChange={handleChange}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-text-main focus:border-primary focus:outline-none disabled:opacity-60"
        aria-label={`Effort for ${modelId}`}
      >
        <option value="auto">Auto</option>
        {levels.map((level) => <option key={level} value={level}>{label(level)}</option>)}
      </select>
    </label>
  );
}

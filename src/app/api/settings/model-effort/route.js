import { NextResponse } from "next/server";
import { getModelEffortKey, getFixedEffortLevel } from "open-sse/services/modelEffort.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { stripThinkingSuffix } from "open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { updateModelEffortOverride } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (typeof body?.provider !== "string" || typeof body?.model !== "string" || !body.model.trim()) {
      return NextResponse.json({ error: "provider and model are required" }, { status: 400 });
    }

    const provider = resolveProviderAlias(body.provider.trim());
    const model = stripThinkingSuffix(body.model.trim());
    const key = getModelEffortKey(provider, model);
    const effort = typeof body.effort === "string" ? body.effort.trim().toLowerCase() : body.effort;
    const levels = getThinkingLevels(provider, model);
    const fixed = getFixedEffortLevel(provider, model);
    const validChoices = fixed ? ["auto"] : ["auto", ...(levels || [])];

    if (effort == null || effort === "auto") {
      const settings = await updateModelEffortOverride(key, null);
      return NextResponse.json({ key, effort: "auto", modelOverrides: settings.modelOverrides });
    }

    if (typeof effort !== "string" || !levels?.includes(effort) || fixed) {
      const choices = validChoices.map((choice) => choice === "auto" ? "Auto" : choice);
      return NextResponse.json({
        error: fixed
          ? `Effort is fixed at ${fixed}.`
          : levels
            ? `Invalid effort. Valid choices: ${choices.join(", ")}.`
            : "Effort is not supported for this model.",
        validChoices,
      }, { status: 400 });
    }

    const settings = await updateModelEffortOverride(key, effort);
    return NextResponse.json({ key, effort, modelOverrides: settings.modelOverrides });
  } catch (error) {
    console.error("Error updating model effort:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

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
    if (Object.hasOwn(body, "locked") && typeof body.locked !== "boolean") {
      return NextResponse.json({ error: "locked must be a boolean" }, { status: 400 });
    }
    if (!Object.hasOwn(body, "effort")) {
      return NextResponse.json({ error: "effort is required" }, { status: 400 });
    }

    const provider = resolveProviderAlias(body.provider.trim());
    const model = stripThinkingSuffix(body.model.trim());
    const key = getModelEffortKey(provider, model);
    const effort = typeof body.effort === "string" ? body.effort.trim().toLowerCase() : body.effort;
    const levels = getThinkingLevels(provider, model);
    const fixed = getFixedEffortLevel(provider, model);
    const validChoices = fixed ? ["auto"] : ["auto", ...(levels || [])];
    const locked = body.locked === true;

    if (effort == null || effort === "auto") {
      if (locked) {
        return NextResponse.json({ error: "A cleared effort cannot be locked" }, { status: 400 });
      }
      const settings = await updateModelEffortOverride(key, null, false);
      return NextResponse.json({ key, effort: "auto", locked: false, modelOverrides: settings.modelOverrides });
    }

    if (typeof effort !== "string" || !levels?.includes(effort) || fixed) {
      const choices = validChoices.map((choice) => choice === "auto" ? "Provider default" : choice);
      return NextResponse.json({
        error: fixed
          ? `Effort is fixed at ${fixed}.`
          : levels
            ? `Invalid effort. Valid choices: ${choices.join(", ")}.`
            : "Effort is not supported for this model.",
        validChoices,
      }, { status: 400 });
    }

    const settings = await updateModelEffortOverride(key, effort, locked);
    return NextResponse.json({ key, effort, locked, modelOverrides: settings.modelOverrides });
  } catch (error) {
    console.error("Error updating model effort:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

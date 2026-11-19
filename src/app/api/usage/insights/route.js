import { NextResponse } from "next/server";
import { getUsageInsights, INSIGHT_PERIODS } from "@/lib/usage/insights";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "24h";
    if (!INSIGHT_PERIODS.includes(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    return NextResponse.json(await getUsageInsights(period));
  } catch (error) {
    console.error("[API] Failed to get usage insights:", error);
    return NextResponse.json({ error: "Failed to fetch usage insights" }, { status: 500 });
  }
}

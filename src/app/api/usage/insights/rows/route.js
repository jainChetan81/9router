import { NextResponse } from "next/server";
import { getUsageInsightRows, INSIGHT_PERIODS } from "@/lib/usage/insights";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "24h";
    if (!INSIGHT_PERIODS.includes(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    const result = await getUsageInsightRows({
      period,
      combo: searchParams.get("combo"),
      member: searchParams.get("member"),
      status: searchParams.get("status"),
      trace: searchParams.get("trace"),
      tag: searchParams.get("tag"),
      limit: searchParams.get("limit"),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] Failed to get usage rows:", error);
    return NextResponse.json({ error: "Failed to fetch usage rows" }, { status: 500 });
  }
}

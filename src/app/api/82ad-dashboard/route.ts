import { NextResponse } from "next/server";
import { loadEightySecondDashboard } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dashboard = await loadEightySecondDashboard();
    return NextResponse.json(dashboard);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load 82AD server stats.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { enrichMissingHllRecordsKpm } from "@/lib/hllRecords";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const summary = await enrichMissingHllRecordsKpm(50);
    return NextResponse.json({ summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh HLLRecords KPM.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { enrichHllRecordsKpm } from "@/lib/hllRecords";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const limit = Number(process.env.HLLRECORDS_REFRESH_LIMIT || 5);
    const summary = await enrichHllRecordsKpm(Number.isFinite(limit) && limit > 0 ? limit : 5, true);
    return NextResponse.json({ summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh HLLRecords KPM.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

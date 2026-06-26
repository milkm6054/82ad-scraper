import { NextResponse } from "next/server";
import { enrichHllRecordsKpm, type HllRecordsKpmMode } from "@/lib/hllRecords";

export const dynamic = "force-dynamic";

function normalizeMode(value: string | null): HllRecordsKpmMode {
  return value === "failed" || value === "refresh" ? value : "pending";
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    let mode = normalizeMode(url.searchParams.get("mode"));

    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await request.json().catch(() => null)) as { mode?: string } | null;
      mode = normalizeMode(body?.mode ?? mode);
    }

    const limit = Number(process.env.HLLRECORDS_REFRESH_LIMIT || 5);
    const summary = await enrichHllRecordsKpm(Number.isFinite(limit) && limit > 0 ? limit : 5, mode);
    return NextResponse.json({ summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh HLLRecords KPM.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

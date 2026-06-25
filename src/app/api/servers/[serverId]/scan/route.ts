import { NextResponse } from "next/server";
import { scanTrackedServer } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  try {
    const { serverId } = await params;
    const summary = await scanTrackedServer(serverId);
    return NextResponse.json({ summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to scan tracked server.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { deleteTrackedServer } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await params;
    await deleteTrackedServer(serverId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete tracked server.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

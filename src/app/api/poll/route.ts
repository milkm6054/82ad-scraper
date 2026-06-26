import { NextResponse } from "next/server";
import { runScheduledPoll } from "@/lib/scanner";

export const dynamic = "force-dynamic";

let pollInProgress = false;

export async function POST() {
  if (pollInProgress) {
    return NextResponse.json({ error: "Poll already in progress." }, { status: 409 });
  }

  pollInProgress = true;
  try {
    const summary = await runScheduledPoll();
    return NextResponse.json({ summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to poll tracked servers.";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    pollInProgress = false;
  }
}

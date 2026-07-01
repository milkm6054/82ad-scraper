import { NextResponse } from "next/server";
import { isAuthorizedCronRequest, runEightySecondHllRecordsCron } from "@/lib/cron";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  try {
    const summary = await runEightySecondHllRecordsCron();
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run 82AD HLL KPM cron.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

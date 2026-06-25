import { NextResponse } from "next/server";
import { createTrackedServer, saveScanResult, scanGameUrl } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      gameUrl?: string;
      serverName?: string;
    };

    if (!body.gameUrl?.trim()) {
      return NextResponse.json({ error: "Game URL is required." }, { status: 400 });
    }

    const parsed = new URL(body.gameUrl);
    const server = await createTrackedServer({
      name: body.serverName || parsed.hostname,
      baseUrl: `${parsed.protocol}//${parsed.host}`,
    });
    const scan = await scanGameUrl(body.gameUrl);
    const saved = await saveScanResult(server.id, scan);

    return NextResponse.json({
      gameId: scan.gameId,
      qualifiedPlayers: scan.qualifiedPlayers.length,
      savedSightings: saved.savedSightings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to scan game.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

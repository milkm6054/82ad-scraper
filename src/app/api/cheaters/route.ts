import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      steamId64?: string;
      name?: string;
    };

    const steamId64 = body.steamId64?.trim() || "";
    const name = body.name?.trim() || steamId64;

    if (!steamId64) {
      return NextResponse.json({ error: "steamId64 is required." }, { status: 400 });
    }

    const excludedPlayer = await prisma.excludedPlayer.upsert({
      where: { steamId64 },
      create: {
        steamId64,
        name,
        reason: "CHEATER",
      },
      update: {
        name,
        reason: "CHEATER",
      },
    });

    await prisma.spottedPlayer.deleteMany({
      where: { steamId64 },
    });

    return NextResponse.json({ excludedPlayer }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark player as cheater.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

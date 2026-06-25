import { NextResponse } from "next/server";
import { createTrackedServer } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      baseUrl?: string;
    };

    if (!body.baseUrl?.trim()) {
      return NextResponse.json({ error: "Server URL is required." }, { status: 400 });
    }

    const server = await createTrackedServer({
      name: body.name || "",
      baseUrl: body.baseUrl,
    });

    return NextResponse.json({
      server: {
        id: server.id,
        name: server.name,
        baseUrl: server.baseUrl,
        lastCheckedAt: server.lastCheckedAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add tracked server.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

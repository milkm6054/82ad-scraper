import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadActiveRosterSteamIds } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [servers, players, pollState] = await Promise.all([
      prisma.trackedServer.findMany({
        orderBy: [{ createdAt: "desc" }],
        include: {
          _count: {
            select: {
              games: true,
            },
          },
        },
      }),
      prisma.spottedPlayer.findMany({
        orderBy: [{ sightings: { _count: "desc" } }, { name: "asc" }],
        include: {
          sightings: {
            orderBy: [{ kpm: "desc" }],
            include: {
              processedGame: {
                include: {
                  server: true,
                },
              },
            },
          },
          _count: {
            select: {
              sightings: true,
            },
          },
        },
      }),
      prisma.pollState.findUnique({
        where: { id: "global" },
      }),
    ]);

    const activeRosterSteamIds = await loadActiveRosterSteamIds(players.map((player) => player.steamId64));
    const freePlayers = players.filter((player) => !activeRosterSteamIds.has(player.steamId64));

    return NextResponse.json({
      servers: servers.map((server) => ({
        id: server.id,
        name: server.name,
        baseUrl: server.baseUrl,
        lastCheckedAt: server.lastCheckedAt?.toISOString() ?? null,
        processedGames: server._count.games,
      })),
      pollState: {
        intervalMinutes: pollState?.intervalMinutes ?? 120,
        lastStartedAt: pollState?.lastStartedAt?.toISOString() ?? null,
        lastFinishedAt: pollState?.lastFinishedAt?.toISOString() ?? null,
        nextRunAt: pollState?.nextRunAt?.toISOString() ?? null,
        lastSummary: pollState?.lastSummary ?? null,
      },
      players: freePlayers.map((player) => ({
        id: player.id,
        name: player.name,
        steamId64: player.steamId64,
        hllRecordsUrl: player.hllRecordsUrl,
        timesSpotted: player._count.sightings,
        sightings: player.sightings.map((sighting) => ({
          id: sighting.id,
          kills: sighting.kills,
          kpm: sighting.kpm,
          allowedKills: sighting.allowedKills,
          allowedKillPercent: sighting.allowedKillPercent,
          killsByType: sighting.killsByType,
          weapons: sighting.weapons,
          game: {
            id: sighting.processedGame.id,
            externalGameId: sighting.processedGame.externalGameId,
            gameLink: sighting.processedGame.gameLink,
            mapName: sighting.processedGame.mapName,
            durationSeconds: sighting.processedGame.durationSeconds,
            startedAt: sighting.processedGame.startedAt?.toISOString() ?? null,
            serverName: sighting.processedGame.server.name,
          },
        })),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load dashboard.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

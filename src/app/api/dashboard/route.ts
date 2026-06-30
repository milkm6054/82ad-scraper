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
    const hllRecordsKpm = freePlayers.reduce(
      (counts, player) => {
        if (typeof player.hllRecordsKpm180 === "number" && player.hllRecordsKpm180 > 0) {
          counts.ready += 1;
        } else if (player.hllRecordsStatError || (typeof player.hllRecordsKpm180 === "number" && player.hllRecordsKpm180 <= 0)) {
          counts.failed += 1;
        } else {
          counts.pending += 1;
        }

        return counts;
      },
      { ready: 0, pending: 0, failed: 0, total: freePlayers.length },
    );
    const hllRecordsBatchSize = Number(process.env.HLLRECORDS_REFRESH_LIMIT || 5);
    const hllRecordsIntervalMinutes = Number(process.env.HLLRECORDS_KPM_INTERVAL_MINUTES || 30);
    const storedSummary =
      pollState?.lastSummary && typeof pollState.lastSummary === "object" && !Array.isArray(pollState.lastSummary)
        ? (pollState.lastSummary as { trackedServers?: unknown })
        : null;
    const trackedServerSummary = storedSummary?.trackedServers ?? pollState?.lastSummary ?? null;

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
        lastSummary: trackedServerSummary,
      },
      hllRecordsKpm,
      hllRecordsKpmQueue: {
        batchSize: Number.isFinite(hllRecordsBatchSize) && hllRecordsBatchSize > 0 ? hllRecordsBatchSize : 5,
        intervalMinutes:
          Number.isFinite(hllRecordsIntervalMinutes) && hllRecordsIntervalMinutes > 0
            ? hllRecordsIntervalMinutes
            : 30,
      },
      players: freePlayers.map((player) => ({
        id: player.id,
        name: player.name,
        steamId64: player.steamId64,
        hllRecordsUrl: player.hllRecordsUrl,
        hllRecordsKpm180: player.hllRecordsKpm180,
        hllRecordsStatError: player.hllRecordsStatError,
        hllRecordsStatFetchedAt: player.hllRecordsStatFetchedAt?.toISOString() ?? null,
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

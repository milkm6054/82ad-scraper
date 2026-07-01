import { NextResponse } from "next/server";
import { enrichHllRecordsKpmForSteamIds } from "@/lib/hllRecords";
import {
  loadCachedEightySecondDashboard,
  loadContactedPlayers,
  loadStoredHllRecordsKpmBySteamId,
  refreshAndStoreEightySecondDashboard,
} from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "1";
    const dashboard = forceRefresh
      ? await refreshAndStoreEightySecondDashboard()
      : (await loadCachedEightySecondDashboard()) ?? (await refreshAndStoreEightySecondDashboard());
    const allSteamIds = [...dashboard.players, ...dashboard.rosteredPlayers].map((player) => player.steamId64);
    const visibleSteamIds = dashboard.players
      .map((player) => player.steamId64)
      .filter((steamId64) => /^\d{17}$/.test(steamId64));
    const hllRecordsDebug = await enrichHllRecordsKpmForSteamIds(visibleSteamIds, 5, {
      force: forceRefresh,
    });
    const [contactedPlayers, latestHllRecordsBySteamId] = await Promise.all([
      loadContactedPlayers(allSteamIds),
      loadStoredHllRecordsKpmBySteamId(allSteamIds),
    ]);

    const playerNameBySteamId = new Map(
      [...dashboard.players, ...dashboard.rosteredPlayers].map((player) => [player.steamId64, player.name]),
    );
    const currentBatch = hllRecordsDebug.currentBatch
      .filter((item) => playerNameBySteamId.has(item.steamId64))
      .map((item) => ({
        steamId64: item.steamId64,
        name: playerNameBySteamId.get(item.steamId64) || item.name || item.steamId64,
      }));
    const queuedPlayers = hllRecordsDebug.queue
      .filter((item) => playerNameBySteamId.has(item.steamId64))
      .map((item) => ({
        steamId64: item.steamId64,
        name: playerNameBySteamId.get(item.steamId64) || item.name || item.steamId64,
      }));

    const withLatestKpm = <T extends { steamId64: string; hllRecordsKpm180: number | null; hllRecordsUrl: string | null }>(
      player: T,
    ) => {
      const latest = latestHllRecordsBySteamId.get(player.steamId64);
      return {
        ...player,
        hllRecordsKpm180: latest?.hllRecordsKpm180 ?? player.hllRecordsKpm180,
        hllRecordsUrl: latest?.hllRecordsUrl ?? player.hllRecordsUrl,
      };
    };

    return NextResponse.json({
      ...dashboard,
      players: dashboard.players.map((player) => ({
        ...withLatestKpm(player),
        contactedAt: contactedPlayers.get(player.steamId64)?.contactedAt?.toISOString() ?? null,
      })),
      rosteredPlayers: dashboard.rosteredPlayers.map((player) => ({
        ...withLatestKpm(player),
        contactedAt: contactedPlayers.get(player.steamId64)?.contactedAt?.toISOString() ?? null,
      })),
      contactedPlayers: dashboard.players
        .filter((player) => contactedPlayers.has(player.steamId64))
        .map((player) => ({
          ...withLatestKpm(player),
          contactedAt: contactedPlayers.get(player.steamId64)?.contactedAt?.toISOString() ?? null,
        })),
      hllRecordsDebug: {
        pendingCount: hllRecordsDebug.pendingCount,
        currentBatch,
        queue: queuedPlayers,
        status: hllRecordsDebug.status,
        lastStartedAt: hllRecordsDebug.lastStartedAt,
        lastFinishedAt: hllRecordsDebug.lastFinishedAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load 82AD server stats.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

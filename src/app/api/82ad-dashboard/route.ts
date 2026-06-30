import { NextResponse } from "next/server";
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
    const [contactedPlayers, latestHllRecordsBySteamId] = await Promise.all([
      loadContactedPlayers(allSteamIds),
      loadStoredHllRecordsKpmBySteamId(allSteamIds),
    ]);

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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load 82AD server stats.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

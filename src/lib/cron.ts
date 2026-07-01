import { enrichHllRecordsKpmForSteamIds } from "@/lib/hllRecords";
import {
  loadCachedEightySecondDashboard,
  refreshAndStoreEightySecondDashboard,
} from "@/lib/scanner";

function getHllRecordsBatchLimit() {
  const configured = Number(process.env.HLLRECORDS_REFRESH_LIMIT || 5);
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

export async function runEightySecondHllRecordsCron(options?: {
  forceRefresh82ad?: boolean;
  forceEnrich?: boolean;
}) {
  const dashboard = options?.forceRefresh82ad
    ? await refreshAndStoreEightySecondDashboard()
    : (await loadCachedEightySecondDashboard()) ?? (await refreshAndStoreEightySecondDashboard());
  const visibleSteamIds = dashboard.players
    .map((player) => player.steamId64)
    .filter((steamId64) => /^\d{17}$/.test(steamId64));
  const debug = await enrichHllRecordsKpmForSteamIds(visibleSteamIds, getHllRecordsBatchLimit(), {
    force: options?.forceEnrich,
  });

  return {
    playersTracked: visibleSteamIds.length,
    pendingCount: debug.pendingCount,
    currentBatchSize: debug.currentBatch.length,
    queuePreviewSize: debug.queue.length,
    status: debug.status,
    lastStartedAt: debug.lastStartedAt,
    lastFinishedAt: debug.lastFinishedAt,
  };
}

export function isAuthorizedCronRequest(request: Request) {
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret) {
    return process.env.NODE_ENV !== "production";
  }

  const authHeader = request.headers.get("authorization")?.trim();
  const cronHeader = request.headers.get("x-cron-secret")?.trim();
  return authHeader === `Bearer ${expectedSecret}` || cronHeader === expectedSecret;
}

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";

const execFileAsync = promisify(execFile);
const PYTHON_CANDIDATES = [process.env.PYTHON_BIN?.trim(), "python3", "python"].filter(
  (value): value is string => Boolean(value),
);
const STEAM_ID64_PATTERN = /^\d{17}$/;

type PythonFetchResult = {
  steamId64?: string;
  sourceUrl: string;
  pageTitle?: string;
  kpm180: number | null;
  duelStrength180: number | null;
  mainRole?: string | null;
  error?: string;
};

export type HllRecordStatResult = {
  sourceUrl: string;
  kpm180: number | null;
};

export type HllRecordsKpmMode = "pending" | "failed" | "refresh";
type HllRecordsQueueItem = {
  steamId64: string;
  name: string;
};

export type HllRecordsDebugState = {
  status: "idle" | "running";
  mode: HllRecordsKpmMode;
  totalPending: number;
  currentBatch: HllRecordsQueueItem[];
  queue: HllRecordsQueueItem[];
  checked: number;
  updated: number;
  failed: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
};

type HllRecordsQueueSummary = {
  mode: HllRecordsKpmMode;
  pendingCount: number;
  failedCount: number;
  currentBatch: HllRecordsQueueItem[];
  queue: HllRecordsQueueItem[];
  status: "idle" | "running";
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
};

let hllRecordsRunInProgress = false;

async function runPythonScraper(args: string[]): Promise<string> {
  const scriptPath = path.join(process.cwd(), "scripts", "fetch_hll_stats.py");
  // A profile can take roughly 10–15 seconds while HLLRecords loads. Scale the
  // process deadline for direct bulk calls instead of killing Python midway.
  const timeout = Math.max(120_000, 30_000 + args.length * 20_000);
  let rawOutput = "";
  let lastError = "";

  for (const pythonBin of PYTHON_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, [scriptPath, ...args], {
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      rawOutput = stdout.trim() || stderr.trim();
      lastError = "";
      break;
    } catch (error) {
      const execError = error as Error & {
        stdout?: string;
        stderr?: string;
        code?: string;
        killed?: boolean;
        signal?: string;
      };
      lastError =
        execError.killed || execError.signal === "SIGTERM"
          ? `HLLRecords scrape timed out after ${Math.ceil(timeout / 1000)} seconds for ${args.length} profile(s).`
          : execError.stdout?.trim() || execError.stderr?.trim() || execError.message;

      if (execError.code === "ENOENT") {
        continue;
      }

      rawOutput = lastError;
      break;
    }
  }

  if (!rawOutput && lastError) {
    rawOutput = lastError;
  }

  if (!rawOutput) {
    throw new Error(
      `HLLRecords scraper returned no output. Tried Python binaries: ${PYTHON_CANDIDATES.join(", ") || "none"}.`,
    );
  }

  return rawOutput;
}

function parseSingleResult(parsed: PythonFetchResult): HllRecordStatResult {
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  if (parsed.kpm180 === null) {
    throw new Error("HLLRecords scraper did not return KPM.");
  }

  if (parsed.kpm180 <= 0) {
    throw new Error("HLLRecords returned 0 KPM for this profile.");
  }

  return {
    sourceUrl: parsed.sourceUrl,
    kpm180: parsed.kpm180,
  };
}

export async function fetchHllRecordStatsBatch(
  steamIds64: string[],
): Promise<Map<string, HllRecordStatResult | Error>> {
  const steamIds = Array.from(new Set(steamIds64.map((steamId) => steamId.trim()).filter(Boolean)));
  if (steamIds.length === 0) {
    return new Map();
  }
  const validSteamIds = steamIds.filter((steamId) => STEAM_ID64_PATTERN.test(steamId));
  const invalidSteamIds = steamIds.filter((steamId) => !STEAM_ID64_PATTERN.test(steamId));
  const results = new Map<string, HllRecordStatResult | Error>();

  for (const steamId64 of invalidSteamIds) {
    results.set(steamId64, new Error("Not a Steam ID64; HLLRecords profile KPM is unavailable."));
  }

  if (validSteamIds.length === 0) {
    return results;
  }

  const rawOutput = await runPythonScraper(validSteamIds);

  let parsed: PythonFetchResult[] | PythonFetchResult;
  try {
    parsed = JSON.parse(rawOutput) as PythonFetchResult[] | PythonFetchResult;
  } catch {
    throw new Error(`Unexpected HLLRecords scraper output: ${rawOutput}`);
  }

  if (!Array.isArray(parsed) && parsed?.error) {
    throw new Error(parsed.error);
  }

  const parsedItems = Array.isArray(parsed) ? parsed : [parsed];

  for (const steamId64 of validSteamIds) {
    results.set(steamId64, new Error("No HLLRecords result returned for this player."));
  }

  for (const item of parsedItems) {
    const steamId64 = item.steamId64?.trim();
    if (!steamId64) {
      continue;
    }

    try {
      results.set(steamId64, parseSingleResult(item));
    } catch (error) {
      results.set(steamId64, error instanceof Error ? error : new Error("Unknown HLLRecords scrape error."));
    }
  }

  return results;
}

async function fetchAndStoreHllRecordsBatch(steamIds: string[]) {
  let statsBySteamId: Map<string, HllRecordStatResult | Error>;

  try {
    // The Python scraper keeps one Chromium instance open for every ID in this
    // call. Calling it once per player exhausts Railway's process allowance.
    statsBySteamId = await fetchHllRecordStatsBatch(steamIds);
  } catch (error) {
    const scraperError = error instanceof Error ? error : new Error("Failed to fetch HLLRecords profile stats.");
    statsBySteamId = new Map(steamIds.map((steamId) => [steamId, scraperError]));
  }

  let updated = 0;
  let failed = 0;

  for (const steamId64 of steamIds) {
    const fetchedAt = new Date();
    const stats = statsBySteamId.get(steamId64);

    if (stats && !(stats instanceof Error)) {
      await prisma.spottedPlayer.update({
        where: { steamId64 },
        data: {
          hllRecordsKpm180: stats.kpm180,
          hllRecordsStatError: null,
          hllRecordsStatFetchedAt: fetchedAt,
        },
      });
      updated += 1;
      continue;
    }

    await prisma.spottedPlayer.update({
      where: { steamId64 },
      data: {
        hllRecordsStatError: stats instanceof Error ? stats.message : "No HLLRecords result returned for this player.",
        hllRecordsStatFetchedAt: fetchedAt,
      },
    });
    failed += 1;
  }

  return { updated, failed };
}

function getQueueWhere(mode: HllRecordsKpmMode) {
  if (mode === "failed") {
    return {
      OR: [{ hllRecordsStatError: { not: null } }, { hllRecordsKpm180: { lte: 0 } }],
    };
  }

  if (mode === "refresh") {
    return undefined;
  }

  return {
    hllRecordsStatError: null,
    OR: [{ hllRecordsKpm180: null }, { hllRecordsKpm180: { lte: 0 } }],
  };
}

function getHllRecordsIntervalMinutes() {
  const configured = Number(process.env.HLLRECORDS_KPM_INTERVAL_MINUTES || 30);
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

async function listQueuePlayers(mode: HllRecordsKpmMode, take: number, excludeSteamIds: string[] = []) {
  return prisma.spottedPlayer.findMany({
    where: {
      ...getQueueWhere(mode),
      ...(excludeSteamIds.length > 0
        ? {
            steamId64: {
              notIn: excludeSteamIds,
            },
          }
        : {}),
    },
    orderBy: [
      { hllRecordsStatFetchedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
    ],
    take,
    select: {
      steamId64: true,
      name: true,
    },
  });
}

async function listQueuePlayersForSteamIds(
  steamIds: string[],
  mode: HllRecordsKpmMode,
  take: number,
  excludeSteamIds: string[] = [],
) {
  const uniqueSteamIds = Array.from(new Set(steamIds.map((steamId) => steamId.trim()).filter(Boolean)));
  if (uniqueSteamIds.length === 0) {
    return [];
  }

  return prisma.spottedPlayer.findMany({
    where: {
      steamId64: {
        in: uniqueSteamIds,
        ...(excludeSteamIds.length > 0 ? { notIn: excludeSteamIds } : {}),
      },
      ...getQueueWhere(mode),
    },
    orderBy: [{ hllRecordsStatFetchedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take,
    select: {
      steamId64: true,
      name: true,
    },
  });
}

async function countQueuePlayers(mode: HllRecordsKpmMode) {
  return prisma.spottedPlayer.count({
    where: getQueueWhere(mode),
  });
}

async function countQueuePlayersForSteamIds(steamIds: string[], mode: HllRecordsKpmMode) {
  const uniqueSteamIds = Array.from(new Set(steamIds.map((steamId) => steamId.trim()).filter(Boolean)));
  if (uniqueSteamIds.length === 0) {
    return 0;
  }

  return prisma.spottedPlayer.count({
    where: {
      steamId64: {
        in: uniqueSteamIds,
      },
      ...getQueueWhere(mode),
    },
  });
}

async function saveHllRecordsDebugState({
  status,
  mode,
  currentBatch,
  queue,
  checked,
  updated,
  failed,
  startedAt,
  finishedAt,
}: {
  status: "idle" | "running";
  mode: HllRecordsKpmMode;
  currentBatch: HllRecordsQueueItem[];
  queue: HllRecordsQueueItem[];
  checked: number;
  updated: number;
  failed: number;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}) {
  const intervalMinutes = getHllRecordsIntervalMinutes();
  const totalPending = await countQueuePlayers("pending");

  await prisma.pollState.upsert({
    where: { id: "hllrecords" },
    create: {
      id: "hllrecords",
      intervalMinutes,
      lastStartedAt: startedAt ?? null,
      lastFinishedAt: finishedAt ?? null,
      nextRunAt: new Date((finishedAt ?? startedAt ?? new Date()).getTime() + intervalMinutes * 60 * 1000),
      lastSummary: {
        status,
        mode,
        totalPending,
        currentBatch,
        queue,
        checked,
        updated,
        failed,
      },
    },
    update: {
      intervalMinutes,
      lastStartedAt: startedAt ?? undefined,
      lastFinishedAt: finishedAt ?? undefined,
      nextRunAt: new Date((finishedAt ?? startedAt ?? new Date()).getTime() + intervalMinutes * 60 * 1000),
      lastSummary: {
        status,
        mode,
        totalPending,
        currentBatch,
        queue,
        checked,
        updated,
        failed,
      },
    },
  });
}

export async function loadHllRecordsDebugState(): Promise<HllRecordsDebugState> {
  const state = await prisma.pollState.findUnique({
    where: { id: "hllrecords" },
    select: {
      lastStartedAt: true,
      lastFinishedAt: true,
      lastSummary: true,
    },
  });

  const summary =
    state?.lastSummary && typeof state.lastSummary === "object" && !Array.isArray(state.lastSummary)
      ? (state.lastSummary as Record<string, unknown>)
      : null;

  const toQueueItems = (value: unknown): HllRecordsQueueItem[] =>
    Array.isArray(value)
      ? value
          .map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? {
                  steamId64:
                    typeof (item as Record<string, unknown>).steamId64 === "string"
                      ? ((item as Record<string, unknown>).steamId64 as string)
                      : "",
                  name:
                    typeof (item as Record<string, unknown>).name === "string"
                      ? ((item as Record<string, unknown>).name as string)
                      : "",
                }
              : null,
          )
          .filter((item): item is HllRecordsQueueItem => Boolean(item?.steamId64))
      : [];

  return {
    status: summary?.status === "running" ? "running" : "idle",
    mode: summary?.mode === "failed" || summary?.mode === "refresh" ? (summary.mode as HllRecordsKpmMode) : "pending",
    totalPending: typeof summary?.totalPending === "number" ? summary.totalPending : 0,
    currentBatch: toQueueItems(summary?.currentBatch),
    queue: toQueueItems(summary?.queue),
    checked: typeof summary?.checked === "number" ? summary.checked : 0,
    updated: typeof summary?.updated === "number" ? summary.updated : 0,
    failed: typeof summary?.failed === "number" ? summary.failed : 0,
    lastStartedAt: state?.lastStartedAt?.toISOString() ?? null,
    lastFinishedAt: state?.lastFinishedAt?.toISOString() ?? null,
  };
}

export async function loadHllRecordsQueueSummaryForSteamIds(
  steamIds: string[],
  previewTake = 20,
): Promise<HllRecordsQueueSummary> {
  const uniqueSteamIds = Array.from(new Set(steamIds.map((steamId) => steamId.trim()).filter(Boolean)));
  if (uniqueSteamIds.length === 0) {
    return {
      mode: "pending",
      pendingCount: 0,
      failedCount: 0,
      currentBatch: [],
      queue: [],
      status: "idle",
      lastStartedAt: null,
      lastFinishedAt: null,
    };
  }

  const [debugState, pendingRows, pendingCount, failedCount, failedRows] = await Promise.all([
    loadHllRecordsDebugState(),
    listQueuePlayersForSteamIds(uniqueSteamIds, "pending", previewTake + 32),
    countQueuePlayersForSteamIds(uniqueSteamIds, "pending"),
    countQueuePlayersForSteamIds(uniqueSteamIds, "failed"),
    listQueuePlayersForSteamIds(uniqueSteamIds, "failed", previewTake + 32),
  ]);
  const activeMode: HllRecordsKpmMode = pendingCount > 0 ? "pending" : failedCount > 0 ? "failed" : "pending";
  const activeRows = activeMode === "pending" ? pendingRows : failedRows;
  const activeSteamIds = new Set(activeRows.map((player) => player.steamId64));
  const currentBatch = debugState.currentBatch.filter((player) => activeSteamIds.has(player.steamId64));
  const currentBatchIds = new Set(currentBatch.map((player) => player.steamId64));
  const queuedFromDebug = debugState.queue.filter(
    (player) => activeSteamIds.has(player.steamId64) && !currentBatchIds.has(player.steamId64),
  );

  const queue = [...queuedFromDebug];
  if (queue.length < previewTake) {
    for (const player of activeRows) {
      if (currentBatchIds.has(player.steamId64) || queue.some((item) => item.steamId64 === player.steamId64)) {
        continue;
      }
      queue.push(player);
      if (queue.length >= previewTake) {
        break;
      }
    }
  }

  return {
    mode: currentBatch.length > 0 ? debugState.mode : activeMode,
    pendingCount,
    failedCount,
    currentBatch,
    queue,
    status: currentBatch.length > 0 ? "running" : "idle",
    lastStartedAt: debugState.lastStartedAt,
    lastFinishedAt: debugState.lastFinishedAt,
  };
}

async function processHllRecordsBatchForSteamIds({
  uniqueSteamIds,
  batch,
  mode,
  previewTake,
  startedAt,
}: {
  uniqueSteamIds: string[];
  batch: HllRecordsQueueItem[];
  mode: HllRecordsKpmMode;
  previewTake: number;
  startedAt: Date;
}) {
  let updated = 0;
  let failed = 0;

  try {
    ({ updated, failed } = await fetchAndStoreHllRecordsBatch(batch.map((player) => player.steamId64)));
  } finally {
    const remainingQueue = await listQueuePlayersForSteamIds(uniqueSteamIds, mode, previewTake);
    await saveHllRecordsDebugState({
      status: "idle",
      mode,
      currentBatch: [],
      queue: remainingQueue,
      checked: batch.length,
      updated,
      failed,
      startedAt,
      finishedAt: new Date(),
    });
    hllRecordsRunInProgress = false;
  }
}

export async function startHllRecordsKpmForSteamIds(
  steamIds: string[],
  limit = 5,
  options?: { force?: boolean; previewTake?: number; mode?: HllRecordsKpmMode; retryFailedWhenPendingEmpty?: boolean },
) {
  const uniqueSteamIds = Array.from(
    new Set(steamIds.map((steamId) => steamId.trim()).filter((steamId) => STEAM_ID64_PATTERN.test(steamId))),
  );
  const previewTake = options?.previewTake ?? 20;

  if (uniqueSteamIds.length === 0) {
    return loadHllRecordsQueueSummaryForSteamIds([], previewTake);
  }

  if (hllRecordsRunInProgress) {
    return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
  }

  const pendingCount = await countQueuePlayersForSteamIds(uniqueSteamIds, "pending");
  const selectedMode =
    options?.mode ??
    (options?.retryFailedWhenPendingEmpty && pendingCount === 0 && (await countQueuePlayersForSteamIds(uniqueSteamIds, "failed")) > 0
      ? "failed"
      : "pending");
  const debugState = await loadHllRecordsDebugState();
  const intervalMinutes = getHllRecordsIntervalMinutes();
  const now = Date.now();
  const lastFinishedAt = debugState.lastFinishedAt ? new Date(debugState.lastFinishedAt).getTime() : 0;
  const skipCooldown = options?.force || selectedMode === "failed";
  const isDue = skipCooldown || !lastFinishedAt || now - lastFinishedAt >= intervalMinutes * 60 * 1000;

  if (debugState.status === "running" || !isDue) {
    return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
  }

  const batch = await listQueuePlayersForSteamIds(uniqueSteamIds, selectedMode, Math.max(1, limit));
  if (batch.length === 0) {
    return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
  }

  hllRecordsRunInProgress = true;
  const startedAt = new Date();
  const batchSteamIds = batch.map((player) => player.steamId64);
  const queuePreview = await listQueuePlayersForSteamIds(uniqueSteamIds, selectedMode, previewTake, batchSteamIds);

  await saveHllRecordsDebugState({
    status: "running",
    mode: selectedMode,
    currentBatch: batch,
    queue: queuePreview,
    checked: batch.length,
    updated: 0,
    failed: 0,
    startedAt,
  });

  void processHllRecordsBatchForSteamIds({
    uniqueSteamIds,
    batch,
    mode: selectedMode,
    previewTake,
    startedAt,
  });

  return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
}

export async function enrichHllRecordsKpmForSteamIds(
  steamIds: string[],
  limit = 5,
  options?: { force?: boolean; previewTake?: number; mode?: HllRecordsKpmMode },
) {
  const uniqueSteamIds = Array.from(
    new Set(steamIds.map((steamId) => steamId.trim()).filter((steamId) => STEAM_ID64_PATTERN.test(steamId))),
  );
  const previewTake = options?.previewTake ?? 20;

  if (uniqueSteamIds.length === 0) {
    return loadHllRecordsQueueSummaryForSteamIds([], previewTake);
  }

  if (hllRecordsRunInProgress) {
    return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
  }

  const debugState = await loadHllRecordsDebugState();
  const intervalMinutes = getHllRecordsIntervalMinutes();
  const now = Date.now();
  const lastFinishedAt = debugState.lastFinishedAt ? new Date(debugState.lastFinishedAt).getTime() : 0;
  const isDue =
    options?.force || !lastFinishedAt || now - lastFinishedAt >= intervalMinutes * 60 * 1000;

  if (debugState.status === "running" || !isDue) {
    return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
  }

  const selectedMode = options?.mode ?? "pending";
  const batch = await listQueuePlayersForSteamIds(uniqueSteamIds, selectedMode, Math.max(1, limit));
  if (batch.length === 0) {
    return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
  }

  hllRecordsRunInProgress = true;
  const startedAt = new Date();

  try {
    const batchSteamIds = batch.map((player) => player.steamId64);
    const queuePreview = await listQueuePlayersForSteamIds(uniqueSteamIds, selectedMode, previewTake, batchSteamIds);

    await saveHllRecordsDebugState({
      status: "running",
      mode: selectedMode,
      currentBatch: batch,
      queue: queuePreview,
      checked: batch.length,
      updated: 0,
      failed: 0,
      startedAt,
    });

    const { updated, failed } = await fetchAndStoreHllRecordsBatch(batchSteamIds);

    const remainingQueue = await listQueuePlayersForSteamIds(uniqueSteamIds, selectedMode, previewTake);
    await saveHllRecordsDebugState({
      status: "idle",
      mode: selectedMode,
      currentBatch: [],
      queue: remainingQueue,
      checked: batch.length,
      updated,
      failed,
      startedAt,
      finishedAt: new Date(),
    });
  } finally {
    hllRecordsRunInProgress = false;
  }

  return loadHllRecordsQueueSummaryForSteamIds(uniqueSteamIds, previewTake);
}

export async function enrichHllRecordsKpm(limit = 25, mode: HllRecordsKpmMode = "pending") {
  const startedAt = new Date();
  const priorityPlayers = await listQueuePlayers(mode, limit);

  const steamIds = priorityPlayers.map((player) => player.steamId64);
  if (steamIds.length === 0) {
    await saveHllRecordsDebugState({
      status: "idle",
      mode,
      currentBatch: [],
      queue: [],
      checked: 0,
      updated: 0,
      failed: 0,
      startedAt,
      finishedAt: new Date(),
    });
    return { checked: 0, updated: 0, failed: 0 };
  }

  const queuePreview = await listQueuePlayers("pending", 20, steamIds);
  await saveHllRecordsDebugState({
    status: "running",
    mode,
    currentBatch: priorityPlayers,
    queue: queuePreview,
    checked: steamIds.length,
    updated: 0,
    failed: 0,
    startedAt,
  });

  const { updated, failed } = await fetchAndStoreHllRecordsBatch(steamIds);

  const remainingQueue = await listQueuePlayers("pending", 20);
  await saveHllRecordsDebugState({
    status: "idle",
    mode,
    currentBatch: [],
    queue: remainingQueue,
    checked: steamIds.length,
    updated,
    failed,
    startedAt,
    finishedAt: new Date(),
  });

  return { checked: steamIds.length, updated, failed, mode };
}

export async function enrichMissingHllRecordsKpm(limit = 25) {
  return enrichHllRecordsKpm(limit, "pending");
}

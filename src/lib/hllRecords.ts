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

async function runPythonScraper(args: string[]): Promise<string> {
  const scriptPath = path.join(process.cwd(), "scripts", "fetch_hll_stats.py");
  let rawOutput = "";
  let lastError = "";

  for (const pythonBin of PYTHON_CANDIDATES) {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, [scriptPath, ...args], {
        timeout: 120000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      rawOutput = stdout.trim() || stderr.trim();
      lastError = "";
      break;
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string; code?: string };
      lastError = execError.stdout?.trim() || execError.stderr?.trim() || execError.message;

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

async function countQueuePlayers(mode: HllRecordsKpmMode) {
  return prisma.spottedPlayer.count({
    where: getQueueWhere(mode),
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

  let updated = 0;
  let failed = 0;

  for (const steamId64 of steamIds) {
    const fetchedAt = new Date();
    let stats: HllRecordStatResult | Error | undefined;

    try {
      stats = (await fetchHllRecordStatsBatch([steamId64])).get(steamId64);
    } catch (error) {
      stats = error instanceof Error ? error : new Error("Failed to fetch HLLRecords profile stats.");
    }

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

    const message = stats instanceof Error ? stats.message : "No HLLRecords result returned for this player.";
    await prisma.spottedPlayer.update({
      where: { steamId64 },
      data: {
        hllRecordsStatError: message,
        hllRecordsStatFetchedAt: fetchedAt,
      },
    });
    failed += 1;
  }

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

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";

const execFileAsync = promisify(execFile);
const PYTHON_CANDIDATES = [process.env.PYTHON_BIN?.trim(), "python3", "python"].filter(
  (value): value is string => Boolean(value),
);

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

  const rawOutput = await runPythonScraper(steamIds);

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

  const results = new Map<string, HllRecordStatResult | Error>();

  for (const steamId64 of steamIds) {
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

export async function enrichHllRecordsKpm(limit = 25, includeExisting = false) {
  const players = await prisma.spottedPlayer.findMany({
    where: includeExisting ? undefined : { hllRecordsKpm180: null },
    orderBy: [
      { hllRecordsStatFetchedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
    ],
    take: limit,
    select: {
      steamId64: true,
    },
  });

  const steamIds = players.map((player) => player.steamId64);
  if (steamIds.length === 0) {
    return { checked: 0, updated: 0, failed: 0 };
  }

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

  return { checked: steamIds.length, updated, failed };
}

export async function enrichMissingHllRecordsKpm(limit = 25) {
  return enrichHllRecordsKpm(limit, false);
}

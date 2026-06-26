import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchHllRecordStatsBatch, HllRecordStatResult } from "@/lib/hllRecords";

const ALLOWED_KILL_TYPES = new Set(["infantry", "sniper", "machine_gun"]);
const MIN_KILLS = 40;
const MIN_KPM = 1.0;
const MIN_ALLOWED_SHARE = 0.70;
const DEFAULT_POLL_INTERVAL_MINUTES = 120;

type ScoreboardMap = {
  id: number;
  start?: string | null;
  end?: string | null;
  map?: {
    pretty_name?: string | null;
  } | null;
  map_name?: string | null;
};

type PlayerStat = {
  player_id?: string | null;
  player?: string | null;
  kills?: number | null;
  kills_per_minute?: number | null;
  kills_by_type?: Record<string, number | null> | null;
  weapons?: Record<string, number | null> | null;
};

type GameScoreboard = {
  result?: {
    id?: number;
    start?: string | null;
    end?: string | null;
    map_name?: string | null;
    map?: {
      pretty_name?: string | null;
    } | null;
    player_stats?: PlayerStat[];
  };
  failed?: boolean;
  error?: string | null;
};

type GameHistory = {
  result?: {
    maps?: ScoreboardMap[];
  };
  failed?: boolean;
  error?: string | null;
};

type QualifiedPlayer = {
  steamId64: string;
  name: string;
  kills: number;
  kpm: number;
  allowedKills: number;
  allowedKillPercent: number;
  killsByType: Record<string, number>;
  weapons: Record<string, number>;
};

export type RosteredPlayer = {
  steamId64: string;
};

type ScanGameResult = {
  gameId: string;
  gameLink: string;
  mapName: string | null;
  durationSeconds: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  qualifiedPlayers: QualifiedPlayer[];
};

export type ServerScanSummary = {
  serverId: string;
  serverName: string;
  checkedGames: number;
  newlyProcessedGames: number;
  spottedSightings: number;
};

type FailedServerScan = {
  serverId: string;
  serverName: string;
  error: string;
};

export type AllServerScanSummary = {
  checkedServers: number;
  successfulServers: number;
  failedServers: number;
  checkedGames: number;
  newlyProcessedGames: number;
  spottedSightings: number;
  summaries: ServerScanSummary[];
  failures: FailedServerScan[];
};

function normalizeBaseUrl(rawUrl: string) {
  const parsed = new URL(rawUrl.trim());
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";
  return parsed.toString().replace(/\/$/, "");
}

async function resolveStatsWrapperBaseUrl(baseUrl: string) {
  let response: Response;
  try {
    response = await fetch(baseUrl, {
      cache: "no-store",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      },
    });
  } catch {
    return baseUrl;
  }

  if (!response.ok) {
    return baseUrl;
  }

  const html = await response.text();
  const wrappedUrl =
    html.match(/<meta\s+name=["']url["']\s+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<frame[^>]+src=["']([^"']+)["']/i)?.[1];

  if (!wrappedUrl) {
    return baseUrl;
  }

  try {
    return normalizeBaseUrl(wrappedUrl);
  } catch {
    return baseUrl;
  }
}

function parseGameUrl(rawUrl: string) {
  const parsed = new URL(rawUrl.trim());
  const parts = parsed.pathname.split("/").filter(Boolean);
  const gameId = parts.at(-1);

  if (parts.at(-2) !== "games" || !gameId || !/^\d+$/.test(gameId)) {
    throw new Error("Expected a CRCON game URL like https://server/games/5774.");
  }

  const baseUrl = normalizeBaseUrl(`${parsed.protocol}//${parsed.host}`);
  return {
    baseUrl,
    gameId,
    gameLink: `${baseUrl}/games/${gameId}`,
    apiUrl: `${baseUrl}/api/get_map_scoreboard?map_id=${gameId}`,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });
  const text = await response.text();

  if (!response.ok) {
    const detail = text.trim().slice(0, 180);
    throw new Error(`HTTP ${response.status} while fetching ${url}${detail ? `: ${detail}` : ""}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.trim().slice(0, 120) || "empty response";
    throw new Error(
      `Expected JSON while fetching ${url}, got "${preview}". Check the tracked server base URL exposes the CRCON API.`,
    );
  }
}

export function getPollIntervalMinutes() {
  const configured = Number(process.env.POLL_INTERVAL_MINUTES || DEFAULT_POLL_INTERVAL_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_INTERVAL_MINUTES;
}

function parseDate(value?: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDurationSeconds(startedAt: Date | null, endedAt: Date | null) {
  if (!startedAt || !endedAt) {
    return null;
  }

  return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
}

function normalizeNumberMap(value: Record<string, number | null> | null | undefined) {
  const normalized: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value ?? {})) {
    normalized[key] = Number(rawValue ?? 0);
  }
  return normalized;
}

function getQualifiedPlayer(player: PlayerStat): QualifiedPlayer | null {
  const kills = Number(player.kills ?? 0);
  const kpm = Number(player.kills_per_minute ?? 0);

  if (kills <= MIN_KILLS || kpm <= MIN_KPM) {
    return null;
  }

  const killsByType = normalizeNumberMap(player.kills_by_type);
  const allowedKills = Array.from(ALLOWED_KILL_TYPES).reduce((total, type) => total + (killsByType[type] ?? 0), 0);
  const allowedKillPercent = kills > 0 ? allowedKills / kills : 0;

  if (allowedKillPercent < MIN_ALLOWED_SHARE) {
    return null;
  }

  const steamId64 = player.player_id?.trim();
  if (!steamId64) {
    return null;
  }

  return {
    steamId64,
    name: player.player?.trim() || steamId64,
    kills,
    kpm,
    allowedKills,
    allowedKillPercent,
    killsByType,
    weapons: normalizeNumberMap(player.weapons),
  };
}

export async function loadActiveRosterSteamIds(steamIds: string[]) {
  const uniqueSteamIds = Array.from(new Set(steamIds.filter(Boolean)));
  if (uniqueSteamIds.length === 0) {
    return new Set<string>();
  }

  let rosteredPlayers: RosteredPlayer[];
  try {
    rosteredPlayers = await prisma.$queryRaw<RosteredPlayer[]>`
      SELECT DISTINCT p."steamId64"
      FROM "RosterEntry" r
      INNER JOIN "Player" p ON p."id" = r."playerId"
      WHERE r."status" = 'ACTIVE'
      AND p."steamId64" IN (${Prisma.join(uniqueSteamIds)})
    `;
  } catch (error) {
    throw new Error(
      "Unable to read HCA roster tables. Point DATABASE_URL at the shared HCA database containing Player and RosterEntry.",
      { cause: error },
    );
  }

  return new Set(rosteredPlayers.map((player) => player.steamId64));
}

export async function scanGameUrl(gameUrl: string): Promise<ScanGameResult> {
  const game = parseGameUrl(gameUrl);
  const payload = await fetchJson<GameScoreboard>(game.apiUrl);

  if (payload.failed) {
    throw new Error(payload.error || `Scoreboard request failed for ${gameUrl}`);
  }

  const result = payload.result;
  if (!result) {
    throw new Error(`No scoreboard result returned for ${gameUrl}`);
  }

  const startedAt = parseDate(result.start);
  const endedAt = parseDate(result.end);
  const mapName = result.map?.pretty_name || result.map_name || null;
  const qualifiedPlayers = (result.player_stats ?? [])
    .map(getQualifiedPlayer)
    .filter((player): player is QualifiedPlayer => Boolean(player));

  return {
    gameId: String(result.id ?? game.gameId),
    gameLink: game.gameLink,
    mapName,
    durationSeconds: getDurationSeconds(startedAt, endedAt),
    startedAt,
    endedAt,
    qualifiedPlayers,
  };
}

export async function saveScanResult(serverId: string, scan: ScanGameResult) {
  const processedGame = await prisma.processedGame.upsert({
    where: {
      serverId_externalGameId: {
        serverId,
        externalGameId: scan.gameId,
      },
    },
    create: {
      serverId,
      externalGameId: scan.gameId,
      gameLink: scan.gameLink,
      mapName: scan.mapName,
      durationSeconds: scan.durationSeconds,
      startedAt: scan.startedAt,
      endedAt: scan.endedAt,
    },
    update: {
      gameLink: scan.gameLink,
      mapName: scan.mapName,
      durationSeconds: scan.durationSeconds,
      startedAt: scan.startedAt,
      endedAt: scan.endedAt,
      scannedAt: new Date(),
    },
  });

  let savedSightings = 0;
  const activeRosterSteamIds = await loadActiveRosterSteamIds(scan.qualifiedPlayers.map((player) => player.steamId64));
  const unrosteredPlayers = scan.qualifiedPlayers.filter((player) => !activeRosterSteamIds.has(player.steamId64));
  const existingPlayers = await prisma.spottedPlayer.findMany({
    where: {
      steamId64: {
        in: unrosteredPlayers.map((player) => player.steamId64),
      },
    },
    select: {
      steamId64: true,
      hllRecordsKpm180: true,
    },
  });
  const playersWithStats = new Set(
    existingPlayers.filter((player) => typeof player.hllRecordsKpm180 === "number").map((player) => player.steamId64),
  );
  const steamIdsNeedingStats = unrosteredPlayers
    .map((player) => player.steamId64)
    .filter((steamId) => !playersWithStats.has(steamId));
  const fetchedAt = new Date();
  let profileStatsBySteamId = new Map<string, HllRecordStatResult | Error>();

  if (steamIdsNeedingStats.length > 0) {
    try {
      profileStatsBySteamId = await fetchHllRecordStatsBatch(steamIdsNeedingStats);
    } catch (error) {
      const statError = error instanceof Error ? error : new Error("Failed to fetch HLLRecords profile stats.");
      profileStatsBySteamId = new Map(steamIdsNeedingStats.map((steamId) => [steamId, statError]));
    }
  }

  for (const player of unrosteredPlayers) {
    const profileStats = profileStatsBySteamId.get(player.steamId64);
    const statUpdate =
      profileStats && !(profileStats instanceof Error)
        ? {
            hllRecordsKpm180: profileStats.kpm180,
            hllRecordsStatError: null,
            hllRecordsStatFetchedAt: fetchedAt,
          }
        : profileStats instanceof Error
          ? {
              hllRecordsStatError: profileStats.message,
              hllRecordsStatFetchedAt: fetchedAt,
            }
          : {};
    const spottedPlayer = await prisma.spottedPlayer.upsert({
      where: { steamId64: player.steamId64 },
      create: {
        steamId64: player.steamId64,
        name: player.name,
        hllRecordsUrl: `https://hllrecords.com/profiles/${player.steamId64}`,
        ...statUpdate,
      },
      update: {
        name: player.name,
        hllRecordsUrl: `https://hllrecords.com/profiles/${player.steamId64}`,
        ...statUpdate,
      },
    });

    await prisma.playerSighting.upsert({
      where: {
        spottedPlayerId_processedGameId: {
          spottedPlayerId: spottedPlayer.id,
          processedGameId: processedGame.id,
        },
      },
      create: {
        spottedPlayerId: spottedPlayer.id,
        processedGameId: processedGame.id,
        kills: player.kills,
        kpm: player.kpm,
        allowedKills: player.allowedKills,
        allowedKillPercent: player.allowedKillPercent,
        killsByType: player.killsByType as Prisma.InputJsonValue,
        weapons: player.weapons as Prisma.InputJsonValue,
      },
      update: {
        kills: player.kills,
        kpm: player.kpm,
        allowedKills: player.allowedKills,
        allowedKillPercent: player.allowedKillPercent,
        killsByType: player.killsByType as Prisma.InputJsonValue,
        weapons: player.weapons as Prisma.InputJsonValue,
      },
    });
    savedSightings += 1;
  }

  return { processedGame, savedSightings };
}

export async function scanTrackedServer(serverId: string, limit?: number): Promise<ServerScanSummary> {
  const server = await prisma.trackedServer.findUnique({
    where: { id: serverId },
  });

  if (!server) {
    throw new Error("Tracked server not found.");
  }

  const pageLimit = limit ?? Number(process.env.SCAN_PAGE_LIMIT || 25);
  let baseUrl = server.baseUrl;
  let historyUrl = `${baseUrl}/api/get_scoreboard_maps?page=1&limit=${pageLimit}`;
  let history: GameHistory;

  try {
    history = await fetchJson<GameHistory>(historyUrl);
  } catch (error) {
    const resolvedBaseUrl = await resolveStatsWrapperBaseUrl(baseUrl);
    if (resolvedBaseUrl === baseUrl) {
      throw error;
    }

    baseUrl = resolvedBaseUrl;
    historyUrl = `${baseUrl}/api/get_scoreboard_maps?page=1&limit=${pageLimit}`;
    history = await fetchJson<GameHistory>(historyUrl);

    await prisma.trackedServer.update({
      where: { id: serverId },
      data: { baseUrl },
    });
  }

  if (history.failed) {
    throw new Error(history.error || `Failed to load game history from ${server.baseUrl}`);
  }

  const maps = history.result?.maps ?? [];
  const existingGames = await prisma.processedGame.findMany({
    where: {
      serverId,
      externalGameId: {
        in: maps.map((game) => String(game.id)),
      },
    },
    select: {
      externalGameId: true,
    },
  });
  const existingGameIds = new Set(existingGames.map((game) => game.externalGameId));

  let newlyProcessedGames = 0;
  let spottedSightings = 0;

  for (const game of maps) {
    const externalGameId = String(game.id);
    if (existingGameIds.has(externalGameId)) {
      continue;
    }

    const scan = await scanGameUrl(`${baseUrl}/games/${externalGameId}`);
    const saved = await saveScanResult(serverId, scan);
    newlyProcessedGames += 1;
    spottedSightings += saved.savedSightings;
  }

  await prisma.trackedServer.update({
    where: { id: serverId },
    data: { lastCheckedAt: new Date() },
  });

  return {
    serverId,
    serverName: server.name,
    checkedGames: maps.length,
    newlyProcessedGames,
    spottedSightings,
  };
}

export async function scanAllTrackedServers(limit?: number): Promise<AllServerScanSummary> {
  const servers = await prisma.trackedServer.findMany({
    orderBy: [{ createdAt: "asc" }],
  });

  const summaries: ServerScanSummary[] = [];
  const failures: FailedServerScan[] = [];

  for (const server of servers) {
    try {
      summaries.push(await scanTrackedServer(server.id, limit));
    } catch (error) {
      failures.push({
        serverId: server.id,
        serverName: server.name,
        error: error instanceof Error ? error.message : "Failed to scan server.",
      });
    }
  }

  return {
    checkedServers: servers.length,
    successfulServers: summaries.length,
    failedServers: failures.length,
    checkedGames: summaries.reduce((total, summary) => total + summary.checkedGames, 0),
    newlyProcessedGames: summaries.reduce((total, summary) => total + summary.newlyProcessedGames, 0),
    spottedSightings: summaries.reduce((total, summary) => total + summary.spottedSightings, 0),
    summaries,
    failures,
  };
}

export async function runScheduledPoll() {
  const intervalMinutes = getPollIntervalMinutes();
  const startedAt = new Date();

  await prisma.pollState.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      intervalMinutes,
      lastStartedAt: startedAt,
      nextRunAt: new Date(startedAt.getTime() + intervalMinutes * 60 * 1000),
    },
    update: {
      intervalMinutes,
      lastStartedAt: startedAt,
    },
  });

  const summary = await scanAllTrackedServers();
  const finishedAt = new Date();

  await prisma.pollState.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      intervalMinutes,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      nextRunAt: new Date(finishedAt.getTime() + intervalMinutes * 60 * 1000),
      lastSummary: summary as unknown as Prisma.InputJsonValue,
    },
    update: {
      intervalMinutes,
      lastFinishedAt: finishedAt,
      nextRunAt: new Date(finishedAt.getTime() + intervalMinutes * 60 * 1000),
      lastSummary: summary as unknown as Prisma.InputJsonValue,
    },
  });

  return summary;
}

export async function createTrackedServer({ name, baseUrl }: { name: string; baseUrl: string }) {
  const normalizedBaseUrl = await resolveStatsWrapperBaseUrl(normalizeBaseUrl(baseUrl));
  const serverName = name.trim() || new URL(normalizedBaseUrl).hostname;

  return prisma.trackedServer.upsert({
    where: { baseUrl: normalizedBaseUrl },
    create: {
      name: serverName,
      baseUrl: normalizedBaseUrl,
    },
    update: {
      name: serverName,
    },
  });
}

export async function deleteTrackedServer(serverId: string) {
  await prisma.trackedServer.delete({
    where: { id: serverId },
  });
}

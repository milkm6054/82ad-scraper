import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const ALLOWED_KILL_TYPES = new Set(["infantry", "sniper", "machine_gun"]);
const MIN_KILLS = 40;
const MIN_KPM = 1.0;
const MIN_ALLOWED_SHARE = 0.70;

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

function normalizeBaseUrl(rawUrl: string) {
  const parsed = new URL(rawUrl.trim());
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";
  return parsed.toString().replace(/\/$/, "");
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

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  return response.json() as Promise<T>;
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

  for (const player of scan.qualifiedPlayers) {
    if (activeRosterSteamIds.has(player.steamId64)) {
      continue;
    }

    const spottedPlayer = await prisma.spottedPlayer.upsert({
      where: { steamId64: player.steamId64 },
      create: {
        steamId64: player.steamId64,
        name: player.name,
        hllRecordsUrl: `https://hllrecords.com/profiles/${player.steamId64}`,
      },
      update: {
        name: player.name,
        hllRecordsUrl: `https://hllrecords.com/profiles/${player.steamId64}`,
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
  const historyUrl = `${server.baseUrl}/api/get_scoreboard_maps?page=1&limit=${pageLimit}`;
  const history = await fetchJson<GameHistory>(historyUrl);

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

    const scan = await scanGameUrl(`${server.baseUrl}/games/${externalGameId}`);
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

export async function createTrackedServer({ name, baseUrl }: { name: string; baseUrl: string }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
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

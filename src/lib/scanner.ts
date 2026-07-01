import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchHllRecordStatsBatch, HllRecordStatResult } from "@/lib/hllRecords";

const ALLOWED_KILL_TYPES = new Set(["infantry", "sniper", "machine_gun"]);
const MIN_KILLS = 40;
const MIN_KPM = 1.0;
const MIN_ALLOWED_SHARE = 0.70;
const DEFAULT_POLL_INTERVAL_MINUTES = 120;
const DEFAULT_82AD_SCAN_PAGE_LIMIT = 100;
const DEFAULT_82AD_SERVER_CONFIG = [
  { name: "82AD Server 1", baseUrl: "https://server1.82nd.gg" },
  { name: "82AD Server 2", baseUrl: "https://server2.82nd.gg" },
] as const;

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

type ScanCriteria = {
  minKillsExclusive: number;
  minKpmInclusive: number;
  minAllowedShare?: number | null;
  allowedKillTypes?: Set<string> | null;
  minDurationSeconds?: number | null;
};

export type RosteredPlayer = {
  steamId64: string;
};

type RosteredPlayerWithTeam = {
  steamId64: string;
  teamName: string;
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

type EightySecondPlayerSighting = {
  id: string;
  kills: number;
  kpm: number;
  gameLink: string;
  mapName: string | null;
  durationSeconds: number | null;
  startedAt: string | null;
  serverName: string;
};

type EightySecondPlayerSummary = {
  id: string;
  name: string;
  steamId64: string;
  hllRecordsUrl: string | null;
  hllRecordsKpm180: number | null;
  timesSpotted: number;
  bestKpm: number;
  bestKills: number;
  sightings: EightySecondPlayerSighting[];
};

type EightySecondRosteredPlayerSummary = {
  id: string;
  name: string;
  steamId64: string;
  teamName: string;
  hllRecordsUrl: string | null;
  hllRecordsKpm180: number | null;
  timesSpotted: number;
  bestKpm: number;
  bestKills: number;
  sightings: EightySecondPlayerSighting[];
};

type EightySecondServerSummary = {
  name: string;
  baseUrl: string;
  checkedGames: number;
  qualifyingGames: number;
  sightings: number;
  error: string | null;
};

export type EightySecondDashboardSummary = {
  criteria: {
    minKillsExclusive: number;
    minKpmInclusive: number;
    minDurationSeconds: number;
  };
  servers: EightySecondServerSummary[];
  players: EightySecondPlayerSummary[];
  rosteredPlayers: EightySecondRosteredPlayerSummary[];
};

type StoredEightySecondState = {
  dashboard: EightySecondDashboardSummary;
  seenGameIdsByServer: Record<string, string[]>;
};

const TALENT_SPOTTER_CRITERIA: ScanCriteria = {
  minKillsExclusive: MIN_KILLS,
  minKpmInclusive: MIN_KPM,
  minAllowedShare: MIN_ALLOWED_SHARE,
  allowedKillTypes: ALLOWED_KILL_TYPES,
};

const EIGHTYSECOND_CRITERIA: ScanCriteria = {
  minKillsExclusive: 60,
  minKpmInclusive: 0.75,
  minDurationSeconds: 30 * 60,
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

function getQualifiedPlayer(player: PlayerStat, criteria: ScanCriteria): QualifiedPlayer | null {
  const kills = Number(player.kills ?? 0);
  const kpm = Number(player.kills_per_minute ?? 0);

  if (kills <= criteria.minKillsExclusive || kpm < criteria.minKpmInclusive) {
    return null;
  }

  const killsByType = normalizeNumberMap(player.kills_by_type);
  const allowedKillTypes = criteria.allowedKillTypes ?? null;
  const allowedKills = allowedKillTypes
    ? Array.from(allowedKillTypes).reduce((total, type) => total + (killsByType[type] ?? 0), 0)
    : kills;
  const allowedKillPercent = kills > 0 ? allowedKills / kills : 0;

  if (typeof criteria.minAllowedShare === "number" && allowedKillPercent < criteria.minAllowedShare) {
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

function get82adServers() {
  const configured = process.env.EIGHTYSECOND_SERVER_URLS?.trim();
  if (!configured) {
    return DEFAULT_82AD_SERVER_CONFIG.map((server) => ({ ...server }));
  }

  return configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [rawName, rawUrl] = entry.includes("|") ? entry.split("|", 2) : [`82AD Server ${index + 1}`, entry];
      return {
        name: rawName.trim() || `82AD Server ${index + 1}`,
        baseUrl: normalizeBaseUrl(rawUrl.trim()),
      };
    });
}

function buildEightySecondPlayerMap(
  players: Array<EightySecondPlayerSummary | EightySecondRosteredPlayerSummary>,
) {
  return new Map(
    players.map((player) => [
      player.steamId64,
      {
        id: player.id,
        name: player.name,
        steamId64: player.steamId64,
        hllRecordsUrl: player.hllRecordsUrl,
        hllRecordsKpm180: player.hllRecordsKpm180,
        timesSpotted: player.timesSpotted,
        bestKpm: player.bestKpm,
        bestKills: player.bestKills,
        sightings: [...player.sightings],
      } satisfies EightySecondPlayerSummary,
    ]),
  );
}

function mergeEightySecondPlayer(
  playersById: Map<string, EightySecondPlayerSummary>,
  serverName: string,
  scan: ScanGameResult,
  player: QualifiedPlayer,
) {
  const existing =
    playersById.get(player.steamId64) ??
    {
      id: player.steamId64,
      name: player.name,
      steamId64: player.steamId64,
      hllRecordsUrl: /^\d{17}$/.test(player.steamId64) ? `https://hllrecords.com/profiles/${player.steamId64}` : null,
      hllRecordsKpm180: null,
      timesSpotted: 0,
      bestKpm: 0,
      bestKills: 0,
      sightings: [],
    };

  const sightingId = `${serverName}-${scan.gameId}-${player.steamId64}`;
  if (existing.sightings.some((sighting) => sighting.id === sightingId)) {
    return;
  }

  existing.name = player.name;
  existing.timesSpotted += 1;
  existing.bestKpm = Math.max(existing.bestKpm, player.kpm);
  existing.bestKills = Math.max(existing.bestKills, player.kills);
  existing.sightings.push({
    id: sightingId,
    kills: player.kills,
    kpm: player.kpm,
    gameLink: scan.gameLink,
    mapName: scan.mapName,
    durationSeconds: scan.durationSeconds,
    startedAt: scan.startedAt?.toISOString() ?? null,
    serverName,
  });
  playersById.set(player.steamId64, existing);
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

export async function loadExcludedSteamIds(steamIds?: string[]) {
  const uniqueSteamIds = Array.from(new Set((steamIds ?? []).filter(Boolean)));
  const excludedPlayers = await prisma.excludedPlayer.findMany({
    where: uniqueSteamIds.length > 0 ? { steamId64: { in: uniqueSteamIds } } : undefined,
    select: {
      steamId64: true,
    },
  });

  return new Set(excludedPlayers.map((player) => player.steamId64));
}

export async function loadContactedPlayers(steamIds?: string[]) {
  const uniqueSteamIds = Array.from(new Set((steamIds ?? []).filter(Boolean)));
  const contactedPlayers = await prisma.contactedPlayer.findMany({
    where: uniqueSteamIds.length > 0 ? { steamId64: { in: uniqueSteamIds } } : undefined,
    select: {
      steamId64: true,
      name: true,
      contactedAt: true,
    },
  });

  return new Map(
    contactedPlayers.map((player) => [
      player.steamId64,
      {
        name: player.name,
        contactedAt: player.contactedAt,
      },
    ]),
  );
}

export async function loadStoredHllRecordsKpmBySteamId(steamIds: string[]) {
  const uniqueSteamIds = Array.from(new Set(steamIds.filter(Boolean)));
  if (uniqueSteamIds.length === 0) {
    return new Map<string, { hllRecordsKpm180: number | null; hllRecordsUrl: string | null; hllRecordsStatError: string | null }>();
  }

  const players = await prisma.spottedPlayer.findMany({
    where: {
      steamId64: {
        in: uniqueSteamIds,
      },
    },
    select: {
      steamId64: true,
      hllRecordsKpm180: true,
      hllRecordsUrl: true,
      hllRecordsStatError: true,
    },
  });

  return new Map(
    players.map((player) => [
      player.steamId64,
      {
        hllRecordsKpm180:
          typeof player.hllRecordsKpm180 === "number" && player.hllRecordsKpm180 > 0 ? player.hllRecordsKpm180 : null,
        hllRecordsUrl: player.hllRecordsUrl,
        hllRecordsStatError: player.hllRecordsStatError,
      },
    ]),
  );
}

async function loadOrFetchHllRecordsKpmBySteamId(steamIds: string[]) {
  const uniqueSteamIds = Array.from(new Set(steamIds.filter((steamId) => /^\d{17}$/.test(steamId))));
  const kpmBySteamId = new Map<string, number | null>();

  if (uniqueSteamIds.length === 0) {
    return kpmBySteamId;
  }

  const existingPlayers = await prisma.spottedPlayer.findMany({
    where: {
      steamId64: {
        in: uniqueSteamIds,
      },
    },
    select: {
      steamId64: true,
      name: true,
      hllRecordsKpm180: true,
      hllRecordsStatError: true,
    },
  });

  const existingBySteamId = new Map(existingPlayers.map((player) => [player.steamId64, player]));
  const missingSteamIds = uniqueSteamIds.filter((steamId) => {
    const existing = existingBySteamId.get(steamId);
    return !existing || typeof existing.hllRecordsKpm180 !== "number" || existing.hllRecordsKpm180 <= 0;
  });

  for (const player of existingPlayers) {
    kpmBySteamId.set(
      player.steamId64,
      typeof player.hllRecordsKpm180 === "number" && player.hllRecordsKpm180 > 0 ? player.hllRecordsKpm180 : null,
    );
  }

  if (missingSteamIds.length === 0) {
    return kpmBySteamId;
  }

  const fetchedAt = new Date();
  let profileStatsBySteamId = new Map<string, HllRecordStatResult | Error>();

  try {
    profileStatsBySteamId = await fetchHllRecordStatsBatch(missingSteamIds);
  } catch (error) {
    const statError = error instanceof Error ? error : new Error("Failed to fetch HLLRecords profile stats.");
    profileStatsBySteamId = new Map(missingSteamIds.map((steamId) => [steamId, statError]));
  }

  for (const steamId64 of missingSteamIds) {
    const profileStats = profileStatsBySteamId.get(steamId64);
    const statUpdate =
      profileStats && !(profileStats instanceof Error)
        ? {
            hllRecordsKpm180: profileStats.kpm180,
            hllRecordsStatError: null,
            hllRecordsStatFetchedAt: fetchedAt,
          }
        : {
            hllRecordsStatError:
              profileStats instanceof Error
                ? profileStats.message
                : "No HLLRecords result returned for this player.",
            hllRecordsStatFetchedAt: fetchedAt,
          };

    await prisma.spottedPlayer.upsert({
      where: { steamId64 },
      create: {
        steamId64,
        name: existingBySteamId.get(steamId64)?.name || steamId64,
        hllRecordsUrl: `https://hllrecords.com/profiles/${steamId64}`,
        ...statUpdate,
      },
      update: {
        ...statUpdate,
      },
    });

    kpmBySteamId.set(
      steamId64,
      profileStats && !(profileStats instanceof Error) ? profileStats.kpm180 : null,
    );
  }

  return kpmBySteamId;
}

async function loadActiveRosterPlayersWithTeams(steamIds: string[]) {
  const uniqueSteamIds = Array.from(new Set(steamIds.filter(Boolean)));
  if (uniqueSteamIds.length === 0) {
    return new Map<string, string>();
  }

  let rosteredPlayers: RosteredPlayerWithTeam[];
  try {
    rosteredPlayers = await prisma.$queryRaw<RosteredPlayerWithTeam[]>`
      SELECT DISTINCT p."steamId64", t."name" AS "teamName"
      FROM "RosterEntry" r
      INNER JOIN "Player" p ON p."id" = r."playerId"
      INNER JOIN "Team" t ON t."id" = r."teamId"
      WHERE r."status" = 'ACTIVE'
      AND p."steamId64" IN (${Prisma.join(uniqueSteamIds)})
    `;
  } catch (error) {
    throw new Error(
      "Unable to read HCA roster tables. Point DATABASE_URL at the shared HCA database containing Player, RosterEntry, and Team.",
      { cause: error },
    );
  }

  return new Map(rosteredPlayers.map((player) => [player.steamId64, player.teamName]));
}

async function scanGameUrlWithCriteria(gameUrl: string, criteria: ScanCriteria): Promise<ScanGameResult> {
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
  const durationSeconds = getDurationSeconds(startedAt, endedAt);
  if (typeof criteria.minDurationSeconds === "number" && (durationSeconds ?? 0) <= criteria.minDurationSeconds) {
    return {
      gameId: String(result.id ?? game.gameId),
      gameLink: game.gameLink,
      mapName,
      durationSeconds,
      startedAt,
      endedAt,
      qualifiedPlayers: [],
    };
  }
  const qualifiedPlayers = (result.player_stats ?? [])
    .map((player) => getQualifiedPlayer(player, criteria))
    .filter((player): player is QualifiedPlayer => Boolean(player));

  return {
    gameId: String(result.id ?? game.gameId),
    gameLink: game.gameLink,
    mapName,
    durationSeconds,
    startedAt,
    endedAt,
    qualifiedPlayers,
  };
}

export async function scanGameUrl(gameUrl: string): Promise<ScanGameResult> {
  return scanGameUrlWithCriteria(gameUrl, TALENT_SPOTTER_CRITERIA);
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
  const candidateSteamIds = scan.qualifiedPlayers.map((player) => player.steamId64);
  const [activeRosterSteamIds, excludedSteamIds] = await Promise.all([
    loadActiveRosterSteamIds(candidateSteamIds),
    loadExcludedSteamIds(candidateSteamIds),
  ]);
  const unrosteredPlayers = scan.qualifiedPlayers.filter(
    (player) => !activeRosterSteamIds.has(player.steamId64) && !excludedSteamIds.has(player.steamId64),
  );
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

export async function loadEightySecondDashboard(limit?: number): Promise<EightySecondDashboardSummary> {
  const pageLimit = limit ?? Number(process.env.EIGHTYSECOND_SCAN_PAGE_LIMIT || DEFAULT_82AD_SCAN_PAGE_LIMIT);
  const serverDefinitions = get82adServers();
  const playersById = new Map<string, EightySecondPlayerSummary>();
  const rosteredPlayersById = new Map<string, EightySecondRosteredPlayerSummary>();
  const serverSummaries: EightySecondServerSummary[] = [];

  for (const definition of serverDefinitions) {
    let baseUrl = definition.baseUrl;
    let checkedGames = 0;
    let qualifyingGames = 0;
    let sightings = 0;

    try {
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
      }

      if (history.failed) {
        throw new Error(history.error || `Failed to load game history from ${baseUrl}`);
      }

      const maps = history.result?.maps ?? [];
      checkedGames = maps.length;

      for (const game of maps) {
        const externalGameId = String(game.id);
        const scan = await scanGameUrlWithCriteria(`${baseUrl}/games/${externalGameId}`, EIGHTYSECOND_CRITERIA);

        if (scan.qualifiedPlayers.length === 0) {
          continue;
        }

        qualifyingGames += 1;

        for (const player of scan.qualifiedPlayers) {
          sightings += 1;
          mergeEightySecondPlayer(playersById, definition.name, scan, player);
        }
      }

      serverSummaries.push({
        name: definition.name,
        baseUrl,
        checkedGames,
        qualifyingGames,
        sightings,
        error: null,
      });
    } catch (error) {
      serverSummaries.push({
        name: definition.name,
        baseUrl,
        checkedGames,
        qualifyingGames,
        sightings,
        error: error instanceof Error ? error.message : "Failed to load 82AD server stats.",
      });
    }
  }

  const allSteamIds = Array.from(playersById.keys());
  const [rosteredPlayerTeamBySteamId, excludedSteamIds, hllKpmBySteamId] = await Promise.all([
    loadActiveRosterPlayersWithTeams(allSteamIds),
    loadExcludedSteamIds(allSteamIds),
    loadOrFetchHllRecordsKpmBySteamId(allSteamIds),
  ]);
  const unrosteredPlayers = new Map<string, EightySecondPlayerSummary>();

  for (const [steamId64, player] of playersById.entries()) {
    if (excludedSteamIds.has(steamId64)) {
      continue;
    }

    const teamName = rosteredPlayerTeamBySteamId.get(steamId64);
    if (!teamName) {
      player.hllRecordsKpm180 = hllKpmBySteamId.get(steamId64) ?? null;
      unrosteredPlayers.set(steamId64, player);
      continue;
    }

    rosteredPlayersById.set(steamId64, {
      ...player,
      hllRecordsKpm180: hllKpmBySteamId.get(steamId64) ?? null,
      teamName,
    });
  }

  const sortPlayers = <T extends { name: string; bestKpm: number; bestKills: number; sightings: EightySecondPlayerSighting[] }>(
    players: T[],
  ) =>
    players
    .map((player) => ({
      ...player,
      sightings: player.sightings.sort((left, right) => {
        const leftTime = left.startedAt ? new Date(left.startedAt).getTime() : 0;
        const rightTime = right.startedAt ? new Date(right.startedAt).getTime() : 0;
        return rightTime - leftTime;
      }),
    }))
    .sort((left, right) => {
      if (left.bestKpm !== right.bestKpm) {
        return right.bestKpm - left.bestKpm;
      }

      if (left.bestKills !== right.bestKills) {
        return right.bestKills - left.bestKills;
      }

      return left.name.localeCompare(right.name);
    });

  const players = sortPlayers(Array.from(unrosteredPlayers.values()));
  const rosteredPlayers = sortPlayers(Array.from(rosteredPlayersById.values()));

  return {
    criteria: {
      minKillsExclusive: EIGHTYSECOND_CRITERIA.minKillsExclusive,
      minKpmInclusive: EIGHTYSECOND_CRITERIA.minKpmInclusive,
      minDurationSeconds: EIGHTYSECOND_CRITERIA.minDurationSeconds ?? 0,
    },
    servers: serverSummaries,
    players,
    rosteredPlayers,
  };
}

export async function loadCachedEightySecondDashboard() {
  const pollState = await prisma.pollState.findUnique({
    where: { id: "eightysecond" },
    select: {
      lastSummary: true,
    },
  });

  const summary =
    pollState?.lastSummary && typeof pollState.lastSummary === "object" && !Array.isArray(pollState.lastSummary)
      ? (pollState.lastSummary as StoredEightySecondState)
      : null;

  return summary?.dashboard ?? null;
}

export async function refreshAndStoreEightySecondDashboard(limit?: number) {
  const pageLimit = limit ?? Number(process.env.EIGHTYSECOND_SCAN_PAGE_LIMIT || DEFAULT_82AD_SCAN_PAGE_LIMIT);
  const serverDefinitions = get82adServers();
  const intervalMinutes = getPollIntervalMinutes();
  const startedAt = new Date();
  const existingPollState = await prisma.pollState.findUnique({
    where: { id: "eightysecond" },
    select: {
      lastSummary: true,
    },
  });
  const existingState =
    existingPollState?.lastSummary &&
    typeof existingPollState.lastSummary === "object" &&
    !Array.isArray(existingPollState.lastSummary)
      ? (existingPollState.lastSummary as StoredEightySecondState)
      : null;
  const previousDashboard = existingState?.dashboard;
  const playersById = buildEightySecondPlayerMap([
    ...(previousDashboard?.players ?? []),
    ...(previousDashboard?.rosteredPlayers ?? []),
  ]);
  const seenGameIdsByServer: Record<string, string[]> = { ...(existingState?.seenGameIdsByServer ?? {}) };
  const serverSummaries: EightySecondServerSummary[] = [];

  for (const definition of serverDefinitions) {
    let baseUrl = definition.baseUrl;
    const seenGameIds = new Set(seenGameIdsByServer[definition.baseUrl] ?? []);
    const previousServerSummary = previousDashboard?.servers.find((server) => server.baseUrl === definition.baseUrl);
    let checkedGames = previousServerSummary?.checkedGames ?? seenGameIds.size;
    let qualifyingGames = previousServerSummary?.qualifyingGames ?? 0;
    let sightings = previousServerSummary?.sightings ?? 0;

    try {
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
      }

      if (history.failed) {
        throw new Error(history.error || `Failed to load game history from ${baseUrl}`);
      }

      const maps = history.result?.maps ?? [];
      for (const game of maps) {
        const externalGameId = String(game.id);
        if (seenGameIds.has(externalGameId)) {
          continue;
        }

        const scan = await scanGameUrlWithCriteria(`${baseUrl}/games/${externalGameId}`, EIGHTYSECOND_CRITERIA);
        seenGameIds.add(externalGameId);

        if (scan.qualifiedPlayers.length === 0) {
          continue;
        }

        qualifyingGames += 1;
        for (const player of scan.qualifiedPlayers) {
          sightings += 1;
          mergeEightySecondPlayer(playersById, definition.name, scan, player);
        }
      }

      seenGameIdsByServer[definition.baseUrl] = Array.from(seenGameIds);
      checkedGames = seenGameIds.size;
      serverSummaries.push({
        name: definition.name,
        baseUrl,
        checkedGames,
        qualifyingGames,
        sightings,
        error: null,
      });
    } catch (error) {
      serverSummaries.push({
        name: definition.name,
        baseUrl,
        checkedGames,
        qualifyingGames,
        sightings,
        error: error instanceof Error ? error.message : "Failed to load 82AD server stats.",
      });
    }
  }

  const allSteamIds = Array.from(playersById.keys());
  const [rosteredPlayerTeamBySteamId, excludedSteamIds, hllKpmBySteamId] = await Promise.all([
    loadActiveRosterPlayersWithTeams(allSteamIds),
    loadExcludedSteamIds(allSteamIds),
    loadOrFetchHllRecordsKpmBySteamId(allSteamIds),
  ]);
  const unrosteredPlayers = new Map<string, EightySecondPlayerSummary>();
  const refreshedRosteredPlayersById = new Map<string, EightySecondRosteredPlayerSummary>();

  for (const [steamId64, player] of playersById.entries()) {
    if (excludedSteamIds.has(steamId64)) {
      continue;
    }

    const teamName = rosteredPlayerTeamBySteamId.get(steamId64);
    if (!teamName) {
      player.hllRecordsKpm180 = hllKpmBySteamId.get(steamId64) ?? null;
      unrosteredPlayers.set(steamId64, player);
      continue;
    }

    refreshedRosteredPlayersById.set(steamId64, {
      ...player,
      hllRecordsKpm180: hllKpmBySteamId.get(steamId64) ?? null,
      teamName,
    });
  }

  const sortPlayers = <T extends { name: string; bestKpm: number; bestKills: number; sightings: EightySecondPlayerSighting[] }>(
    players: T[],
  ) =>
    players
      .map((player) => ({
        ...player,
        sightings: player.sightings.sort((left, right) => {
          const leftTime = left.startedAt ? new Date(left.startedAt).getTime() : 0;
          const rightTime = right.startedAt ? new Date(right.startedAt).getTime() : 0;
          return rightTime - leftTime;
        }),
      }))
      .sort((left, right) => {
        if (left.bestKpm !== right.bestKpm) {
          return right.bestKpm - left.bestKpm;
        }

        if (left.bestKills !== right.bestKills) {
          return right.bestKills - left.bestKills;
        }

        return left.name.localeCompare(right.name);
      });

  const dashboard: EightySecondDashboardSummary = {
    criteria: {
      minKillsExclusive: EIGHTYSECOND_CRITERIA.minKillsExclusive,
      minKpmInclusive: EIGHTYSECOND_CRITERIA.minKpmInclusive,
      minDurationSeconds: EIGHTYSECOND_CRITERIA.minDurationSeconds ?? 0,
    },
    servers: serverSummaries,
    players: sortPlayers(Array.from(unrosteredPlayers.values())),
    rosteredPlayers: sortPlayers(Array.from(refreshedRosteredPlayersById.values())),
  };
  const finishedAt = new Date();

  await prisma.pollState.upsert({
    where: { id: "eightysecond" },
    create: {
      id: "eightysecond",
      intervalMinutes,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      nextRunAt: new Date(finishedAt.getTime() + intervalMinutes * 60 * 1000),
      lastSummary: {
        dashboard,
        seenGameIdsByServer,
      } as unknown as Prisma.InputJsonValue,
    },
    update: {
      intervalMinutes,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      nextRunAt: new Date(finishedAt.getTime() + intervalMinutes * 60 * 1000),
      lastSummary: {
        dashboard,
        seenGameIdsByServer,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return dashboard;
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

  const trackedServerSummary = await scanAllTrackedServers();
  await refreshAndStoreEightySecondDashboard();
  const finishedAt = new Date();

  await prisma.pollState.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      intervalMinutes,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      nextRunAt: new Date(finishedAt.getTime() + intervalMinutes * 60 * 1000),
      lastSummary: {
        trackedServers: trackedServerSummary,
      } as unknown as Prisma.InputJsonValue,
    },
    update: {
      intervalMinutes,
      lastFinishedAt: finishedAt,
      nextRunAt: new Date(finishedAt.getTime() + intervalMinutes * 60 * 1000),
      lastSummary: {
        trackedServers: trackedServerSummary,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return trackedServerSummary;
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

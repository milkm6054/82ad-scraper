"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type ServerRow = {
  id: string;
  name: string;
  baseUrl: string;
  lastCheckedAt: string | null;
  processedGames: number;
};

type SightingRow = {
  id: string;
  kills: number;
  kpm: number;
  allowedKills: number;
  allowedKillPercent: number;
  killsByType: Record<string, number>;
  game: {
    externalGameId: string;
    gameLink: string;
    mapName: string | null;
    durationSeconds: number | null;
    startedAt: string | null;
    serverName: string;
  };
};

type PlayerRow = {
  id: string;
  name: string;
  steamId64: string;
  hllRecordsUrl: string;
  hllRecordsKpm180: number | null;
  hllRecordsStatError: string | null;
  hllRecordsStatFetchedAt: string | null;
  contactedAt: string | null;
  timesSpotted: number;
  sightings: SightingRow[];
};

type PollSummary = {
  checkedServers: number;
  successfulServers: number;
  failedServers: number;
  checkedGames: number;
  newlyProcessedGames: number;
  spottedSightings: number;
  failures?: { serverId: string; serverName: string; error: string }[];
};

type PollState = {
  intervalMinutes: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  nextRunAt: string | null;
  lastSummary: PollSummary | null;
};

type DashboardResponse = {
  servers: ServerRow[];
  players: PlayerRow[];
  contactedPlayers: PlayerRow[];
  pollState: PollState;
  hllRecordsKpm: {
    ready: number;
    pending: number;
    failed: number;
    total: number;
  };
  hllRecordsKpmQueue: {
    batchSize: number;
    intervalMinutes: number;
  };
};

type EightySecondServerRow = {
  name: string;
  baseUrl: string;
  checkedGames: number;
  qualifyingGames: number;
  sightings: number;
  error: string | null;
};

type EightySecondSightingRow = {
  id: string;
  kills: number;
  kpm: number;
  gameLink: string;
  mapName: string | null;
  durationSeconds: number | null;
  startedAt: string | null;
  serverName: string;
};

type EightySecondPlayerRow = {
  id: string;
  name: string;
  steamId64: string;
  hllRecordsUrl: string | null;
  hllRecordsKpm180: number | null;
  contactedAt: string | null;
  timesSpotted: number;
  bestKpm: number;
  bestKills: number;
  sightings: EightySecondSightingRow[];
};

type EightySecondRosteredPlayerRow = EightySecondPlayerRow & {
  teamName: string;
};

type EightySecondDashboardResponse = {
  criteria: {
    minKillsExclusive: number;
    minKpmInclusive: number;
    minDurationSeconds: number;
  };
  servers: EightySecondServerRow[];
  players: EightySecondPlayerRow[];
  rosteredPlayers: EightySecondRosteredPlayerRow[];
  contactedPlayers: EightySecondPlayerRow[];
};

type PlayerSortKey = "name" | "timesSpotted" | "bestKpm" | "bestKills" | "hllRecordsKpm180";
type EightySecondSortKey = "name" | "timesSpotted" | "bestKpm" | "bestKills" | "hllRecordsKpm180";
type SortDirection = "asc" | "desc";
type DashboardTab = "talent" | "82ad";
async function parseResponse<T>(response: Response): Promise<T & { error?: string }> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Empty response from server (${response.status}).`);
  }

  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(`Unexpected response from server (${response.status}): ${text.slice(0, 200)}`);
  }
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("en-GB");
}

function formatDuration(seconds: number | null) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return "-";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCountdown(nextRunAt: string | null, now: number) {
  if (!nextRunAt) {
    return "Waiting for first poll";
  }

  const remainingMs = new Date(nextRunAt).getTime() - now;
  if (remainingMs <= 0) {
    return "Due now";
  }

  const totalMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatJsonMap(value: Record<string, number>) {
  return Object.entries(value)
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
}

function formatShortError(value: string | null) {
  if (!value) {
    return "";
  }

  return value.length > 56 ? `${value.slice(0, 56)}...` : value;
}

function hasValidHllKpm(player: PlayerRow): player is PlayerRow & { hllRecordsKpm180: number } {
  return typeof player.hllRecordsKpm180 === "number" && player.hllRecordsKpm180 > 0;
}

function getBestKpm(player: PlayerRow) {
  return Math.max(...player.sightings.map((sighting) => sighting.kpm));
}

function getBestKills(player: PlayerRow) {
  return Math.max(...player.sightings.map((sighting) => sighting.kills));
}

function getSortLabel(key: PlayerSortKey, activeKey: PlayerSortKey, direction: SortDirection) {
  if (key !== activeKey) {
    return "";
  }

  return direction === "asc" ? " asc" : " desc";
}

export function TalentDashboard() {
  const [activeTab, setActiveTab] = useState<DashboardTab>("talent");
  const [data, setData] = useState<DashboardResponse>({
    servers: [],
    players: [],
    contactedPlayers: [],
    hllRecordsKpm: { ready: 0, pending: 0, failed: 0, total: 0 },
    hllRecordsKpmQueue: { batchSize: 5, intervalMinutes: 30 },
    pollState: { intervalMinutes: 120, lastStartedAt: null, lastFinishedAt: null, nextRunAt: null, lastSummary: null },
  });
  const [eightySecondData, setEightySecondData] = useState<EightySecondDashboardResponse>({
    criteria: {
      minKillsExclusive: 30,
      minKpmInclusive: 0.75,
      minDurationSeconds: 1800,
    },
    servers: [],
    players: [],
    rosteredPlayers: [],
    contactedPlayers: [],
  });
  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [gameUrl, setGameUrl] = useState("");
  const [expandedPlayerIds, setExpandedPlayerIds] = useState<Set<string>>(() => new Set());
  const [expandedEightySecondPlayerIds, setExpandedEightySecondPlayerIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [scanningServerId, setScanningServerId] = useState<string | null>(null);
  const [deletingServerId, setDeletingServerId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [enrichingHllRecords, setEnrichingHllRecords] = useState(false);
  const [retryingHllRecords, setRetryingHllRecords] = useState(false);
  const [markingCheaterId, setMarkingCheaterId] = useState<string | null>(null);
  const [markingContactedId, setMarkingContactedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loading82ad, setLoading82ad] = useState(false);
  const [refreshing82ad, setRefreshing82ad] = useState(false);
  const [error, setError] = useState("");
  const [eightySecondError, setEightySecondError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [playerSortKey, setPlayerSortKey] = useState<PlayerSortKey>("timesSpotted");
  const [playerSortDirection, setPlayerSortDirection] = useState<SortDirection>("desc");
  const [eightySecondSortKey, setEightySecondSortKey] = useState<EightySecondSortKey>("bestKpm");
  const [eightySecondSortDirection, setEightySecondSortDirection] = useState<SortDirection>("desc");

  const loadDashboard = useCallback(async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    const payload = await parseResponse<DashboardResponse>(response);

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load dashboard.");
    }

    setData({
      servers: payload.servers || [],
      players: payload.players || [],
      contactedPlayers: payload.contactedPlayers || [],
      hllRecordsKpm: payload.hllRecordsKpm || { ready: 0, pending: 0, failed: 0, total: 0 },
      hllRecordsKpmQueue: payload.hllRecordsKpmQueue || { batchSize: 5, intervalMinutes: 30 },
      pollState: payload.pollState || {
        intervalMinutes: 120,
        lastStartedAt: null,
        lastFinishedAt: null,
        nextRunAt: null,
        lastSummary: null,
      },
    });
  }, []);

  const loadEightySecondDashboard = useCallback(async () => {
    const response = await fetch("/api/82ad-dashboard", { cache: "no-store" });
    const payload = await parseResponse<EightySecondDashboardResponse>(response);

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load 82AD server stats.");
    }

    setEightySecondData({
      criteria: payload.criteria || {
        minKillsExclusive: 30,
        minKpmInclusive: 0.75,
        minDurationSeconds: 1800,
      },
      servers: payload.servers || [],
      players: payload.players || [],
      rosteredPlayers: payload.rosteredPlayers || [],
      contactedPlayers: payload.contactedPlayers || [],
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        await loadDashboard();
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (activeTab !== "82ad") {
      return;
    }

    let cancelled = false;

    async function run() {
      setLoading82ad(true);
      try {
        await loadEightySecondDashboard();
      } catch (loadError) {
        if (!cancelled) {
          setEightySecondError(loadError instanceof Error ? loadError.message : "Failed to load 82AD server stats.");
        }
      } finally {
        if (!cancelled) {
          setLoading82ad(false);
        }
      }
    }

    if (eightySecondData.players.length === 0 && eightySecondData.servers.length === 0) {
      void run();
    }

    return () => {
      cancelled = true;
    };
  }, [activeTab, eightySecondData.players.length, eightySecondData.servers.length, loadEightySecondDashboard]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const summary = useMemo(() => {
    const sightings = data.players.reduce((total, player) => total + player.sightings.length, 0);
    return {
      servers: data.servers.length,
      players: data.players.length,
      sightings,
      games: data.servers.reduce((total, server) => total + server.processedGames, 0),
    };
  }, [data]);

  const sortedPlayers = useMemo(() => {
    return [...data.players].sort((left, right) => {
      if (playerSortKey === "name") {
        const comparison = left.name.localeCompare(right.name);
        return playerSortDirection === "asc" ? comparison : -comparison;
      }

      const leftValue =
        playerSortKey === "timesSpotted"
          ? left.timesSpotted
          : playerSortKey === "hllRecordsKpm180"
            ? hasValidHllKpm(left)
              ? left.hllRecordsKpm180 ?? -1
              : -1
          : playerSortKey === "bestKpm"
            ? getBestKpm(left)
            : getBestKills(left);
      const rightValue =
        playerSortKey === "timesSpotted"
          ? right.timesSpotted
          : playerSortKey === "hllRecordsKpm180"
            ? hasValidHllKpm(right)
              ? right.hllRecordsKpm180 ?? -1
              : -1
          : playerSortKey === "bestKpm"
            ? getBestKpm(right)
            : getBestKills(right);

      if (leftValue !== rightValue) {
        return playerSortDirection === "asc" ? leftValue - rightValue : rightValue - leftValue;
      }

      return left.name.localeCompare(right.name);
    });
  }, [data.players, playerSortDirection, playerSortKey]);

  const sortedEightySecondPlayers = useMemo(() => {
    return [...eightySecondData.players].sort((left, right) => {
      if (eightySecondSortKey === "name") {
        const comparison = left.name.localeCompare(right.name);
        return eightySecondSortDirection === "asc" ? comparison : -comparison;
      }

      const leftValue =
        eightySecondSortKey === "timesSpotted"
          ? left.timesSpotted
          : eightySecondSortKey === "hllRecordsKpm180"
            ? typeof left.hllRecordsKpm180 === "number" && left.hllRecordsKpm180 > 0
              ? left.hllRecordsKpm180
              : -1
          : eightySecondSortKey === "bestKpm"
            ? left.bestKpm
            : left.bestKills;
      const rightValue =
        eightySecondSortKey === "timesSpotted"
          ? right.timesSpotted
          : eightySecondSortKey === "hllRecordsKpm180"
            ? typeof right.hllRecordsKpm180 === "number" && right.hllRecordsKpm180 > 0
              ? right.hllRecordsKpm180
              : -1
          : eightySecondSortKey === "bestKpm"
            ? right.bestKpm
            : right.bestKills;

      if (leftValue !== rightValue) {
        return eightySecondSortDirection === "asc" ? leftValue - rightValue : rightValue - leftValue;
      }

      return left.name.localeCompare(right.name);
    });
  }, [eightySecondData.players, eightySecondSortDirection, eightySecondSortKey]);

  async function addServer(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: serverName,
          baseUrl: serverUrl,
        }),
      });
      const payload = await parseResponse<{ server: ServerRow }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to add server.");
      }

      setServerName("");
      setServerUrl("");
      setNotice("Server added.");
      await loadDashboard();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add server.");
    } finally {
      setBusy(false);
    }
  }

  async function scanServer(serverId: string) {
    setScanningServerId(serverId);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/servers/${serverId}/scan`, { method: "POST" });
      const payload = await parseResponse<{
        summary: {
          checkedGames: number;
          newlyProcessedGames: number;
          spottedSightings: number;
        };
      }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to scan server.");
      }

      setNotice(
        `Scanned ${payload.summary.checkedGames} games. New games: ${payload.summary.newlyProcessedGames}. Sightings: ${payload.summary.spottedSightings}.`,
      );
      await loadDashboard();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Failed to scan server.");
    } finally {
      setScanningServerId(null);
    }
  }

  async function deleteServer(serverId: string) {
    const confirmed = window.confirm("Remove this tracked server and its stored games/sightings?");
    if (!confirmed) {
      return;
    }

    setDeletingServerId(serverId);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/servers/${serverId}`, { method: "DELETE" });
      const payload = await parseResponse<{ ok: boolean }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to remove tracked server.");
      }

      setNotice("Tracked server removed.");
      await loadDashboard();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to remove tracked server.");
    } finally {
      setDeletingServerId(null);
    }
  }

  async function runPollNow() {
    setPolling(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/poll", { method: "POST" });
      const payload = await parseResponse<{ summary: PollSummary }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to poll tracked servers.");
      }

      setNotice(
        `Poll complete. Servers: ${payload.summary.successfulServers}/${payload.summary.checkedServers}. New games: ${payload.summary.newlyProcessedGames}. Sightings: ${payload.summary.spottedSightings}.`,
      );
      await loadDashboard();
    } catch (pollError) {
      setError(pollError instanceof Error ? pollError.message : "Failed to poll tracked servers.");
    } finally {
      setPolling(false);
    }
  }

  async function refreshHllRecordsKpm() {
    setEnrichingHllRecords(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/hllrecords/enrich?mode=pending", { method: "POST" });
      const payload = await parseResponse<{ summary: { checked: number; updated: number; failed: number } }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to refresh HLLRecords KPM.");
      }

      setNotice(
        `HLLRecords pending check processed ${payload.summary.checked} players. Updated: ${payload.summary.updated}. Failed: ${payload.summary.failed}.`,
      );
      await loadDashboard();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh HLLRecords KPM.");
    } finally {
      setEnrichingHllRecords(false);
    }
  }

  async function retryFailedHllRecordsKpm() {
    setRetryingHllRecords(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/hllrecords/enrich?mode=failed", { method: "POST" });
      const payload = await parseResponse<{ summary: { checked: number; updated: number; failed: number } }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to retry failed HLLRecords KPM.");
      }

      setNotice(
        `HLLRecords failed retry processed ${payload.summary.checked} players. Updated: ${payload.summary.updated}. Still failed: ${payload.summary.failed}.`,
      );
      await loadDashboard();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Failed to retry failed HLLRecords KPM.");
    } finally {
      setRetryingHllRecords(false);
    }
  }

  async function refreshEightySecondDashboard() {
    setRefreshing82ad(true);
    setEightySecondError("");

    try {
      const response = await fetch("/api/82ad-dashboard?refresh=1", { cache: "no-store" });
      const payload = await parseResponse<EightySecondDashboardResponse>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to refresh 82AD server stats.");
      }

      setEightySecondData({
        criteria: payload.criteria || {
          minKillsExclusive: 30,
          minKpmInclusive: 0.75,
          minDurationSeconds: 1800,
        },
        servers: payload.servers || [],
        players: payload.players || [],
        rosteredPlayers: payload.rosteredPlayers || [],
        contactedPlayers: payload.contactedPlayers || [],
      });
    } catch (refreshError) {
      setEightySecondError(
        refreshError instanceof Error ? refreshError.message : "Failed to refresh 82AD server stats.",
      );
    } finally {
      setRefreshing82ad(false);
    }
  }

  async function scanGame(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/scan-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameUrl }),
      });
      const payload = await parseResponse<{
        gameId: string;
        qualifiedPlayers: number;
        savedSightings: number;
      }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to scan game.");
      }

      setGameUrl("");
      setNotice(`Game ${payload.gameId} scanned. Qualified players: ${payload.qualifiedPlayers}.`);
      await loadDashboard();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Failed to scan game.");
    } finally {
      setBusy(false);
    }
  }

  async function markAsCheater(player: { steamId64: string; name: string }, source: DashboardTab) {
    const confirmed = window.confirm(`Mark ${player.name} as a cheater and hide them from future results?`);
    if (!confirmed) {
      return;
    }

    setMarkingCheaterId(player.steamId64);
    setError("");
    setEightySecondError("");
    setNotice("");

    try {
      const response = await fetch("/api/cheaters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(player),
      });
      const payload = await parseResponse<{ excludedPlayer: { steamId64: string } }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to mark player as cheater.");
      }

      if (source === "talent") {
        await loadDashboard();
      } else {
        const refreshResponse = await fetch("/api/82ad-dashboard?refresh=1", { cache: "no-store" });
        const refreshPayload = await parseResponse<EightySecondDashboardResponse>(refreshResponse);

        if (!refreshResponse.ok) {
          throw new Error(refreshPayload.error || "Failed to refresh 82AD server stats.");
        }

        setEightySecondData({
          criteria: refreshPayload.criteria || {
            minKillsExclusive: 30,
            minKpmInclusive: 0.75,
            minDurationSeconds: 1800,
          },
          servers: refreshPayload.servers || [],
          players: refreshPayload.players || [],
          rosteredPlayers: refreshPayload.rosteredPlayers || [],
          contactedPlayers: refreshPayload.contactedPlayers || [],
        });
      }

      setNotice(`${player.name} marked as cheater and excluded from future results.`);
    } catch (markError) {
      const message = markError instanceof Error ? markError.message : "Failed to mark player as cheater.";
      if (source === "talent") {
        setError(message);
      } else {
        setEightySecondError(message);
      }
    } finally {
      setMarkingCheaterId(null);
    }
  }

  async function markAsContacted(player: { steamId64: string; name: string }, source: DashboardTab) {
    setMarkingContactedId(player.steamId64);
    setError("");
    setEightySecondError("");
    setNotice("");

    try {
      const response = await fetch("/api/contacted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(player),
      });
      const payload = await parseResponse<{ contactedPlayer: { steamId64: string; contactedAt: string } }>(response);

      if (!response.ok) {
        throw new Error(payload.error || "Failed to mark player as contacted.");
      }

      if (source === "talent") {
        await loadDashboard();
      } else {
        const refreshResponse = await fetch("/api/82ad-dashboard?refresh=1", { cache: "no-store" });
        const refreshPayload = await parseResponse<EightySecondDashboardResponse>(refreshResponse);

        if (!refreshResponse.ok) {
          throw new Error(refreshPayload.error || "Failed to refresh 82AD server stats.");
        }

        setEightySecondData({
          criteria: refreshPayload.criteria || {
            minKillsExclusive: 30,
            minKpmInclusive: 0.75,
            minDurationSeconds: 1800,
          },
          servers: refreshPayload.servers || [],
          players: refreshPayload.players || [],
          rosteredPlayers: refreshPayload.rosteredPlayers || [],
          contactedPlayers: refreshPayload.contactedPlayers || [],
        });
      }

      setNotice(`${player.name} marked as contacted.`);
    } catch (markError) {
      const message = markError instanceof Error ? markError.message : "Failed to mark player as contacted.";
      if (source === "talent") {
        setError(message);
      } else {
        setEightySecondError(message);
      }
    } finally {
      setMarkingContactedId(null);
    }
  }

  function togglePlayer(playerId: string) {
    setExpandedPlayerIds((current) => {
      const next = new Set(current);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        next.add(playerId);
      }
      return next;
    });
  }

  function toggleEightySecondPlayer(playerId: string) {
    setExpandedEightySecondPlayerIds((current) => {
      const next = new Set(current);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        next.add(playerId);
      }
      return next;
    });
  }

  function updatePlayerSort(key: PlayerSortKey) {
    if (playerSortKey === key) {
      setPlayerSortDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }

    setPlayerSortKey(key);
    setPlayerSortDirection(key === "name" ? "asc" : "desc");
  }

  function updateEightySecondSort(key: EightySecondSortKey) {
    if (eightySecondSortKey === key) {
      setEightySecondSortDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }

    setEightySecondSortKey(key);
    setEightySecondSortDirection(key === "name" ? "asc" : "desc");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-5 py-6">
      <section className="surface-strong p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="muted text-xs font-semibold uppercase tracking-[0.28em]">82AD Talent Spotter</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">CRCON match scanner</h1>
            <p className="mt-2 max-w-3xl text-sm muted">
              Tracks public CRCON game pages and stores players with more than 40 kills, KPM over 1.00, and at least
              70% of kills from infantry, sniper, or machine gun categories. Active HCA roster players are filtered out.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div className="surface px-4 py-3">
              <p className="muted text-xs uppercase">Servers</p>
              <p className="mt-1 text-2xl font-semibold">{summary.servers}</p>
            </div>
            <div className="surface px-4 py-3">
              <p className="muted text-xs uppercase">Games</p>
              <p className="mt-1 text-2xl font-semibold">{summary.games}</p>
            </div>
            <div className="surface px-4 py-3">
              <p className="muted text-xs uppercase">Players</p>
              <p className="mt-1 text-2xl font-semibold">{summary.players}</p>
            </div>
            <div className="surface px-4 py-3">
              <p className="muted text-xs uppercase">Sightings</p>
              <p className="mt-1 text-2xl font-semibold">{summary.sightings}</p>
            </div>
          </div>
        </div>
      </section>
      <section className="surface p-2">
        <div className="flex flex-wrap gap-2">
          <button
            className={`px-4 py-2 ${activeTab === "talent" ? "primary-button" : ""}`}
            type="button"
            onClick={() => setActiveTab("talent")}
          >
            Talent spotter
          </button>
          <button
            className={`px-4 py-2 ${activeTab === "82ad" ? "primary-button" : ""}`}
            type="button"
            onClick={() => setActiveTab("82ad")}
          >
            82AD server stats
          </button>
        </div>
      </section>

      {activeTab === "talent" ? (
        <>
          {error ? <p className="text-sm text-red-300">{error}</p> : null}
          {notice ? <p className="status-text text-sm">{notice}</p> : null}

          <section className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={addServer} className="surface p-4">
          <h2 className="text-lg font-semibold">Add tracked server</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1.4fr_auto]">
            <input
              className="px-3 py-2"
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
              placeholder="Name, e.g. 82AD"
              disabled={busy}
            />
            <input
              className="px-3 py-2"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://server1.82nd.gg"
              required
              disabled={busy}
            />
            <button className="primary-button px-4 py-2" disabled={busy}>
              Add
            </button>
          </div>
        </form>

        <form onSubmit={scanGame} className="surface p-4">
          <h2 className="text-lg font-semibold">Scan one game</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
            <input
              className="px-3 py-2"
              value={gameUrl}
              onChange={(event) => setGameUrl(event.target.value)}
              placeholder="https://greyrcon.de:81/games/5774"
              required
              disabled={busy}
            />
            <button className="primary-button px-4 py-2" disabled={busy}>
              Scan game
            </button>
          </div>
        </form>
          </section>

          <section className="surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Automatic polling</h2>
            <p className="muted mt-1 text-sm">
              Every {data.pollState.intervalMinutes} minutes | Next poll:{" "}
              <span className="font-semibold text-slate-100">{formatCountdown(data.pollState.nextRunAt, now)}</span>
            </p>
            <p className="muted mt-1 text-xs">
              Last finished {formatDateTime(data.pollState.lastFinishedAt)}
              {data.pollState.lastSummary
                ? ` | ${data.pollState.lastSummary.newlyProcessedGames} new games | ${data.pollState.lastSummary.spottedSightings} sightings | ${data.pollState.lastSummary.failedServers} failures`
                : ""}
            </p>
          </div>
          <button className="primary-button px-4 py-2" type="button" onClick={runPollNow} disabled={polling}>
            {polling ? "Polling..." : "Run poll now"}
          </button>
        </div>
        {data.pollState.lastSummary?.failures?.length ? (
          <div className="mt-3 grid gap-2">
            {data.pollState.lastSummary.failures.slice(0, 3).map((failure) => (
              <p key={failure.serverId} className="text-xs text-amber-200">
                {failure.serverName}: {failure.error}
              </p>
            ))}
          </div>
        ) : null}
          </section>

          <section className="surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Tracked servers</h2>
          {loading ? <span className="muted text-sm">Loading...</span> : null}
        </div>
        <div className="mt-4 grid gap-3">
          {data.servers.map((server) => (
            <div key={server.id} className="surface flex flex-wrap items-center justify-between gap-3 p-3">
              <div>
                <p className="font-semibold">{server.name}</p>
                <a className="subtle-link text-sm underline underline-offset-4" href={server.baseUrl} target="_blank" rel="noreferrer">
                  {server.baseUrl}
                </a>
                <p className="muted mt-1 text-xs">
                  Processed games: {server.processedGames} | Last checked {formatDateTime(server.lastCheckedAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="px-4 py-2"
                  onClick={() => scanServer(server.id)}
                  disabled={scanningServerId === server.id || deletingServerId === server.id}
                  type="button"
                >
                  {scanningServerId === server.id ? "Scanning..." : "Scan recent games"}
                </button>
                <button
                  className="danger-button px-4 py-2"
                  onClick={() => deleteServer(server.id)}
                  disabled={deletingServerId === server.id || scanningServerId === server.id}
                  type="button"
                >
                  {deletingServerId === server.id ? "Removing..." : "Remove"}
                </button>
              </div>
            </div>
          ))}
          {!loading && data.servers.length === 0 ? <p className="muted text-sm">No tracked servers yet.</p> : null}
        </div>
          </section>

          <section className="surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Spotted players</h2>
            <p className="muted mt-1 text-xs">
              HLL KPM: {data.hllRecordsKpm.ready}/{data.hllRecordsKpm.total} ready | {data.hllRecordsKpm.pending} pending |{" "}
              {data.hllRecordsKpm.failed} failed
            </p>
            <p className="muted mt-1 text-xs">
              Getting HLL KPM for up to {data.hllRecordsKpmQueue.batchSize} players every{" "}
              {data.hllRecordsKpmQueue.intervalMinutes} minutes. {data.hllRecordsKpm.pending} left in the automatic queue.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="px-4 py-2" type="button" onClick={refreshHllRecordsKpm} disabled={enrichingHllRecords}>
              {enrichingHllRecords ? "Checking..." : "Check pending now"}
            </button>
            <button
              className="px-4 py-2"
              type="button"
              onClick={retryFailedHllRecordsKpm}
              disabled={retryingHllRecords || data.hllRecordsKpm.failed === 0}
            >
              {retryingHllRecords ? "Retrying..." : "Retry failed"}
            </button>
          </div>
        </div>
        <div className="table-wrap mt-4">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="table-head muted">
              <tr>
                <th className="px-4 py-3">
                  <button className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted" type="button" onClick={() => updatePlayerSort("name")}>
                    Player{getSortLabel("name", playerSortKey, playerSortDirection)}
                  </button>
                </th>
                <th className="px-4 py-3">Steam ID</th>
                <th className="px-4 py-3">
                  <button className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted" type="button" onClick={() => updatePlayerSort("timesSpotted")}>
                    Times spotted{getSortLabel("timesSpotted", playerSortKey, playerSortDirection)}
                  </button>
                </th>
                <th className="px-4 py-3">
                  <button className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted" type="button" onClick={() => updatePlayerSort("bestKpm")}>
                    Best KPM{getSortLabel("bestKpm", playerSortKey, playerSortDirection)}
                  </button>
                </th>
                <th className="w-28 px-3 py-3">
                  <button
                    className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted"
                    type="button"
                    onClick={() => updatePlayerSort("hllRecordsKpm180")}
                  >
                    HLL KPM{getSortLabel("hllRecordsKpm180", playerSortKey, playerSortDirection)}
                  </button>
                </th>
                <th className="px-4 py-3">
                  <button className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted" type="button" onClick={() => updatePlayerSort("bestKills")}>
                    Best kills{getSortLabel("bestKills", playerSortKey, playerSortDirection)}
                  </button>
                </th>
                <th className="px-4 py-3">Profile</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedPlayers.map((player) => {
                const expanded = expandedPlayerIds.has(player.id);
                const bestKpm = getBestKpm(player);
                const bestKills = getBestKills(player);

                return (
                  <Fragment key={player.id}>
                    <tr className={`table-row${player.contactedAt ? " contacted-row" : ""}`}>
                      <td className="px-4 py-3">
                        <div className="status-text font-semibold">{player.name}</div>
                        {player.contactedAt ? (
                          <div className="contacted-note mt-1 text-xs">Messaged {formatDateTime(player.contactedAt)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{player.steamId64}</td>
                      <td className="px-4 py-3">{player.timesSpotted}</td>
                      <td className="px-4 py-3">{bestKpm.toFixed(2)}</td>
                      <td className="w-28 whitespace-nowrap px-3 py-3" title={player.hllRecordsStatError || undefined}>
                        {hasValidHllKpm(player) ? (
                          player.hllRecordsKpm180.toFixed(2)
                        ) : player.hllRecordsStatError ? (
                          <span className="text-amber-200" aria-label={formatShortError(player.hllRecordsStatError)}>
                            Error
                          </span>
                        ) : (
                          <span className="muted">Pending</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{bestKills}</td>
                      <td className="px-4 py-3">
                        <a className="subtle-link underline underline-offset-4" href={player.hllRecordsUrl} target="_blank" rel="noreferrer">
                          HLLRecords
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button className="px-3 py-1.5" type="button" onClick={() => togglePlayer(player.id)}>
                            {expanded ? "Hide" : "Show"}
                          </button>
                          <button
                            className="px-3 py-1.5"
                            type="button"
                            onClick={() => markAsContacted({ steamId64: player.steamId64, name: player.name }, "talent")}
                            disabled={markingContactedId === player.steamId64}
                          >
                            {markingContactedId === player.steamId64 ? "Saving..." : "Mark contacted"}
                          </button>
                          <button
                            className="danger-button px-3 py-1.5"
                            type="button"
                            onClick={() => markAsCheater({ steamId64: player.steamId64, name: player.name }, "talent")}
                            disabled={markingCheaterId === player.steamId64}
                          >
                            {markingCheaterId === player.steamId64 ? "Marking..." : "Mark cheater"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="table-row row-muted">
                        <td colSpan={8} className="px-4 py-4">
                          <div className="grid gap-3">
                            {player.sightings.map((sighting) => (
                              <div key={sighting.id} className="surface p-3">
                                <div className="flex flex-wrap justify-between gap-3">
                                  <div>
                                    <p className="font-semibold">
                                      {sighting.game.serverName} | {sighting.game.mapName || "Unknown map"}
                                    </p>
                                    <p className="muted text-xs">
                                      Game {sighting.game.externalGameId} | {formatDuration(sighting.game.durationSeconds)} |{" "}
                                      {formatDateTime(sighting.game.startedAt)}
                                    </p>
                                  </div>
                                  <a className="subtle-link underline underline-offset-4" href={sighting.game.gameLink} target="_blank" rel="noreferrer">
                                    Game link
                                  </a>
                                </div>
                                <div className="mt-3 grid gap-2 text-sm md:grid-cols-4">
                                  <p>KPM: <span className="font-semibold">{sighting.kpm.toFixed(2)}</span></p>
                                  <p>Kills: <span className="font-semibold">{sighting.kills}</span></p>
                                  <p>Allowed: <span className="font-semibold">{sighting.allowedKills} ({formatPercent(sighting.allowedKillPercent)})</span></p>
                                  <p className="md:col-span-4 muted">Kills by type: {formatJsonMap(sighting.killsByType)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {!loading && data.players.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center muted">
                    No unrostered spotted players yet. Add a server or scan a game to start.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
          </section>

          <section className="surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Actively talking to</h2>
          <p className="muted text-sm">{data.contactedPlayers.length} contacted players</p>
        </div>
        <div className="table-wrap mt-4">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="table-head muted">
              <tr>
                <th className="px-4 py-3">Player</th>
                <th className="px-4 py-3">Steam ID</th>
                <th className="px-4 py-3">Messaged</th>
                <th className="px-4 py-3">Times spotted</th>
                <th className="px-4 py-3">Best KPM</th>
                <th className="px-4 py-3">Best kills</th>
                <th className="px-4 py-3">Profile</th>
              </tr>
            </thead>
            <tbody>
              {data.contactedPlayers.map((player) => (
                <tr key={player.id} className="table-row contacted-row">
                  <td className="status-text px-4 py-3 font-semibold">{player.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">{player.steamId64}</td>
                  <td className="px-4 py-3">{formatDateTime(player.contactedAt)}</td>
                  <td className="px-4 py-3">{player.timesSpotted}</td>
                  <td className="px-4 py-3">{getBestKpm(player).toFixed(2)}</td>
                  <td className="px-4 py-3">{getBestKills(player)}</td>
                  <td className="px-4 py-3">
                    <a className="subtle-link underline underline-offset-4" href={player.hllRecordsUrl} target="_blank" rel="noreferrer">
                      HLLRecords
                    </a>
                  </td>
                </tr>
              ))}
              {!loading && data.contactedPlayers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center muted">
                    No contacted players yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
          </section>
        </>
      ) : (
        <>
          {eightySecondError ? <p className="text-sm text-red-300">{eightySecondError}</p> : null}
          <section className="surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">82AD server stats</h2>
                <p className="muted mt-1 text-sm">
                  Only scans the two 82AD servers and spots players with KPM at or above{" "}
                  <span className="font-semibold text-slate-100">{eightySecondData.criteria.minKpmInclusive.toFixed(2)}</span>,
                  kills greater than{" "}
                  <span className="font-semibold text-slate-100">{eightySecondData.criteria.minKillsExclusive}</span>,
                  and games longer than{" "}
                  <span className="font-semibold text-slate-100">
                    {Math.round(eightySecondData.criteria.minDurationSeconds / 60)} minutes
                  </span>
                  .
                </p>
                <p className="muted mt-1 text-xs">
                  Background polling keeps this updated every 2 hours even with the tab closed, and it looks back across the last 100 games per server.
                </p>
              </div>
              <button
                className="px-4 py-2"
                type="button"
                onClick={refreshEightySecondDashboard}
                disabled={loading82ad || refreshing82ad}
              >
                {loading82ad || refreshing82ad ? "Refreshing..." : "Refresh 82AD stats"}
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {eightySecondData.servers.map((server) => (
                <div key={server.baseUrl} className="surface p-4">
                  <p className="font-semibold">{server.name}</p>
                  <a className="subtle-link mt-1 block text-sm underline underline-offset-4" href={server.baseUrl} target="_blank" rel="noreferrer">
                    {server.baseUrl}
                  </a>
                  <p className="muted mt-2 text-xs">
                    Checked {server.checkedGames} games | Qualifying games {server.qualifyingGames} | Sightings {server.sightings}
                  </p>
                  {server.error ? <p className="mt-2 text-xs text-amber-200">{server.error}</p> : null}
                </div>
              ))}
              {!loading82ad && eightySecondData.servers.length === 0 ? (
                <div className="surface p-4 text-sm muted">No 82AD server data loaded yet.</div>
              ) : null}
            </div>
          </section>

          <section className="surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">82AD spotted players</h2>
              <p className="muted text-sm">
                {eightySecondData.players.length} unrostered players matched the current rules
              </p>
            </div>
            <div className="table-wrap mt-4">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="table-head muted">
                  <tr>
                    <th className="px-4 py-3">
                      <button className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted" type="button" onClick={() => updateEightySecondSort("name")}>
                        Player{getSortLabel("name", eightySecondSortKey, eightySecondSortDirection)}
                      </button>
                    </th>
                    <th className="px-4 py-3">Steam ID</th>
                    <th className="px-4 py-3">
                      <button
                        className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted"
                        type="button"
                        onClick={() => updateEightySecondSort("timesSpotted")}
                      >
                        Times spotted{getSortLabel("timesSpotted", eightySecondSortKey, eightySecondSortDirection)}
                      </button>
                    </th>
                    <th className="px-4 py-3">
                      <button className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted" type="button" onClick={() => updateEightySecondSort("bestKpm")}>
                        Best KPM{getSortLabel("bestKpm", eightySecondSortKey, eightySecondSortDirection)}
                      </button>
                    </th>
                    <th className="px-4 py-3">
                      <button
                        className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted"
                        type="button"
                        onClick={() => updateEightySecondSort("hllRecordsKpm180")}
                      >
                        HLL KPM{getSortLabel("hllRecordsKpm180", eightySecondSortKey, eightySecondSortDirection)}
                      </button>
                    </th>
                    <th className="px-4 py-3">
                      <button className="border-0 bg-transparent p-0 text-left text-sm font-semibold muted" type="button" onClick={() => updateEightySecondSort("bestKills")}>
                        Best kills{getSortLabel("bestKills", eightySecondSortKey, eightySecondSortDirection)}
                      </button>
                    </th>
                    <th className="px-4 py-3">Profile</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEightySecondPlayers.map((player) => {
                    const expanded = expandedEightySecondPlayerIds.has(player.id);

                    return (
                      <Fragment key={player.id}>
                        <tr className={`table-row${player.contactedAt ? " contacted-row" : ""}`}>
                          <td className="px-4 py-3">
                            <div className="status-text font-semibold">{player.name}</div>
                            {player.contactedAt ? (
                              <div className="contacted-note mt-1 text-xs">Messaged {formatDateTime(player.contactedAt)}</div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">{player.steamId64}</td>
                          <td className="px-4 py-3">{player.timesSpotted}</td>
                          <td className="px-4 py-3">{player.bestKpm.toFixed(2)}</td>
                          <td className="px-4 py-3">
                            {typeof player.hllRecordsKpm180 === "number" && player.hllRecordsKpm180 > 0
                              ? player.hllRecordsKpm180.toFixed(2)
                              : "Pending"}
                          </td>
                          <td className="px-4 py-3">{player.bestKills}</td>
                          <td className="px-4 py-3">
                            {player.hllRecordsUrl ? (
                              <a className="subtle-link underline underline-offset-4" href={player.hllRecordsUrl} target="_blank" rel="noreferrer">
                                HLLRecords
                              </a>
                            ) : (
                              <span className="muted">N/A</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              <button className="px-3 py-1.5" type="button" onClick={() => toggleEightySecondPlayer(player.id)}>
                                {expanded ? "Hide" : "Show"}
                              </button>
                              <button
                                className="px-3 py-1.5"
                                type="button"
                                onClick={() => markAsContacted({ steamId64: player.steamId64, name: player.name }, "82ad")}
                                disabled={markingContactedId === player.steamId64}
                              >
                                {markingContactedId === player.steamId64 ? "Saving..." : "Mark contacted"}
                              </button>
                              <button
                                className="danger-button px-3 py-1.5"
                                type="button"
                                onClick={() => markAsCheater({ steamId64: player.steamId64, name: player.name }, "82ad")}
                                disabled={markingCheaterId === player.steamId64}
                              >
                                {markingCheaterId === player.steamId64 ? "Marking..." : "Mark cheater"}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="table-row row-muted">
                            <td colSpan={8} className="px-4 py-4">
                              <div className="grid gap-3">
                                {player.sightings.map((sighting) => (
                                  <div key={sighting.id} className="surface p-3">
                                    <div className="flex flex-wrap justify-between gap-3">
                                      <div>
                                        <p className="font-semibold">
                                          {sighting.serverName} | {sighting.mapName || "Unknown map"}
                                        </p>
                                        <p className="muted text-xs">
                                          {formatDuration(sighting.durationSeconds)} | {formatDateTime(sighting.startedAt)}
                                        </p>
                                      </div>
                                      <a className="subtle-link underline underline-offset-4" href={sighting.gameLink} target="_blank" rel="noreferrer">
                                        Game link
                                      </a>
                                    </div>
                                    <div className="mt-3 grid gap-2 text-sm md:grid-cols-2">
                                      <p>
                                        KPM: <span className="font-semibold">{sighting.kpm.toFixed(2)}</span>
                                      </p>
                                      <p>
                                        Kills: <span className="font-semibold">{sighting.kills}</span>
                                      </p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {!loading82ad && eightySecondData.players.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center muted">
                        No unrostered players matched the 82AD thresholds yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Already on HCA rosters</h2>
              <p className="muted text-sm">
                {eightySecondData.rosteredPlayers.length} rostered players matched the 82AD rules
              </p>
            </div>
            <div className="table-wrap mt-4">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="table-head muted">
                  <tr>
                    <th className="px-4 py-3">Player</th>
                    <th className="px-4 py-3">Team</th>
                    <th className="px-4 py-3">Steam ID</th>
                    <th className="px-4 py-3">Times spotted</th>
                    <th className="px-4 py-3">Best KPM</th>
                    <th className="px-4 py-3">Best kills</th>
                    <th className="px-4 py-3">Profile</th>
                  </tr>
                </thead>
                <tbody>
                  {eightySecondData.rosteredPlayers.map((player) => (
                    <tr key={player.id} className="table-row">
                      <td className="status-text px-4 py-3 font-semibold">{player.name}</td>
                      <td className="px-4 py-3">{player.teamName}</td>
                      <td className="px-4 py-3 font-mono text-xs">{player.steamId64}</td>
                      <td className="px-4 py-3">{player.timesSpotted}</td>
                      <td className="px-4 py-3">{player.bestKpm.toFixed(2)}</td>
                      <td className="px-4 py-3">{player.bestKills}</td>
                      <td className="px-4 py-3">
                        {player.hllRecordsUrl ? (
                          <a className="subtle-link underline underline-offset-4" href={player.hllRecordsUrl} target="_blank" rel="noreferrer">
                            HLLRecords
                          </a>
                        ) : (
                          <span className="muted">N/A</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!loading82ad && eightySecondData.rosteredPlayers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center muted">
                        No rostered players matched the 82AD thresholds.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Actively talking to</h2>
              <p className="muted text-sm">{eightySecondData.contactedPlayers.length} contacted players</p>
            </div>
            <div className="table-wrap mt-4">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="table-head muted">
                  <tr>
                    <th className="px-4 py-3">Player</th>
                    <th className="px-4 py-3">Steam ID</th>
                    <th className="px-4 py-3">Messaged</th>
                    <th className="px-4 py-3">Times spotted</th>
                    <th className="px-4 py-3">Best KPM</th>
                    <th className="px-4 py-3">Best kills</th>
                    <th className="px-4 py-3">Profile</th>
                  </tr>
                </thead>
                <tbody>
                  {eightySecondData.contactedPlayers.map((player) => (
                    <tr key={player.id} className="table-row contacted-row">
                      <td className="status-text px-4 py-3 font-semibold">{player.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{player.steamId64}</td>
                      <td className="px-4 py-3">{formatDateTime(player.contactedAt)}</td>
                      <td className="px-4 py-3">{player.timesSpotted}</td>
                      <td className="px-4 py-3">{player.bestKpm.toFixed(2)}</td>
                      <td className="px-4 py-3">{player.bestKills}</td>
                      <td className="px-4 py-3">
                        {player.hllRecordsUrl ? (
                          <a className="subtle-link underline underline-offset-4" href={player.hllRecordsUrl} target="_blank" rel="noreferrer">
                            HLLRecords
                          </a>
                        ) : (
                          <span className="muted">N/A</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!loading82ad && eightySecondData.contactedPlayers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center muted">
                        No contacted players yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

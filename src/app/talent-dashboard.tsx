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
  timesSpotted: number;
  sightings: SightingRow[];
};

type DashboardResponse = {
  servers: ServerRow[];
  players: PlayerRow[];
};

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

function formatJsonMap(value: Record<string, number>) {
  return Object.entries(value)
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
}

export function TalentDashboard() {
  const [data, setData] = useState<DashboardResponse>({ servers: [], players: [] });
  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [gameUrl, setGameUrl] = useState("");
  const [expandedPlayerIds, setExpandedPlayerIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [scanningServerId, setScanningServerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadDashboard = useCallback(async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    const payload = await parseResponse<DashboardResponse>(response);

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load dashboard.");
    }

    setData({
      servers: payload.servers || [],
      players: payload.players || [],
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

  const summary = useMemo(() => {
    const sightings = data.players.reduce((total, player) => total + player.sightings.length, 0);
    return {
      servers: data.servers.length,
      players: data.players.length,
      sightings,
      games: data.servers.reduce((total, server) => total + server.processedGames, 0),
    };
  }, [data]);

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
              <button
                className="px-4 py-2"
                onClick={() => scanServer(server.id)}
                disabled={scanningServerId === server.id}
                type="button"
              >
                {scanningServerId === server.id ? "Scanning..." : "Scan recent games"}
              </button>
            </div>
          ))}
          {!loading && data.servers.length === 0 ? <p className="muted text-sm">No tracked servers yet.</p> : null}
        </div>
      </section>

      <section className="surface p-4">
        <h2 className="text-lg font-semibold">Spotted players</h2>
        <div className="table-wrap mt-4">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="table-head muted">
              <tr>
                <th className="px-4 py-3">Player</th>
                <th className="px-4 py-3">Steam ID</th>
                <th className="px-4 py-3">Times spotted</th>
                <th className="px-4 py-3">Best KPM</th>
                <th className="px-4 py-3">Best kills</th>
                <th className="px-4 py-3">Profile</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.players.map((player) => {
                const expanded = expandedPlayerIds.has(player.id);
                const bestKpm = Math.max(...player.sightings.map((sighting) => sighting.kpm));
                const bestKills = Math.max(...player.sightings.map((sighting) => sighting.kills));

                return (
                  <Fragment key={player.id}>
                    <tr className="table-row">
                      <td className="status-text px-4 py-3 font-semibold">{player.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{player.steamId64}</td>
                      <td className="px-4 py-3">{player.timesSpotted}</td>
                      <td className="px-4 py-3">{bestKpm.toFixed(2)}</td>
                      <td className="px-4 py-3">{bestKills}</td>
                      <td className="px-4 py-3">
                        <a className="subtle-link underline underline-offset-4" href={player.hllRecordsUrl} target="_blank" rel="noreferrer">
                          HLLRecords
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <button className="px-3 py-1.5" type="button" onClick={() => togglePlayer(player.id)}>
                          {expanded ? "Hide" : "Show"}
                        </button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="table-row row-muted">
                        <td colSpan={7} className="px-4 py-4">
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
                  <td colSpan={7} className="px-4 py-8 text-center muted">
                    No unrostered spotted players yet. Add a server or scan a game to start.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

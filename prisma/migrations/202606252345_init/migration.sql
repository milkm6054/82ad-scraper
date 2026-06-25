CREATE TABLE "TrackedServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedServer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProcessedGame" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "externalGameId" TEXT NOT NULL,
    "gameLink" TEXT NOT NULL,
    "mapName" TEXT,
    "durationSeconds" INTEGER,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedGame_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpottedPlayer" (
    "id" TEXT NOT NULL,
    "steamId64" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hllRecordsUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpottedPlayer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlayerSighting" (
    "id" TEXT NOT NULL,
    "spottedPlayerId" TEXT NOT NULL,
    "processedGameId" TEXT NOT NULL,
    "kills" INTEGER NOT NULL,
    "kpm" DOUBLE PRECISION NOT NULL,
    "allowedKills" INTEGER NOT NULL,
    "allowedKillPercent" DOUBLE PRECISION NOT NULL,
    "killsByType" JSONB NOT NULL,
    "weapons" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerSighting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackedServer_baseUrl_key" ON "TrackedServer"("baseUrl");
CREATE UNIQUE INDEX "ProcessedGame_serverId_externalGameId_key" ON "ProcessedGame"("serverId", "externalGameId");
CREATE INDEX "ProcessedGame_serverId_scannedAt_idx" ON "ProcessedGame"("serverId", "scannedAt");
CREATE UNIQUE INDEX "SpottedPlayer_steamId64_key" ON "SpottedPlayer"("steamId64");
CREATE UNIQUE INDEX "PlayerSighting_spottedPlayerId_processedGameId_key" ON "PlayerSighting"("spottedPlayerId", "processedGameId");
CREATE INDEX "PlayerSighting_processedGameId_idx" ON "PlayerSighting"("processedGameId");
CREATE INDEX "PlayerSighting_spottedPlayerId_idx" ON "PlayerSighting"("spottedPlayerId");

ALTER TABLE "ProcessedGame"
ADD CONSTRAINT "ProcessedGame_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "TrackedServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlayerSighting"
ADD CONSTRAINT "PlayerSighting_spottedPlayerId_fkey"
FOREIGN KEY ("spottedPlayerId") REFERENCES "SpottedPlayer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlayerSighting"
ADD CONSTRAINT "PlayerSighting_processedGameId_fkey"
FOREIGN KEY ("processedGameId") REFERENCES "ProcessedGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

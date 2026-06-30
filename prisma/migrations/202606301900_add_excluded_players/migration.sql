CREATE TABLE "ExcludedPlayer" (
    "id" TEXT NOT NULL,
    "steamId64" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'CHEATER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExcludedPlayer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExcludedPlayer_steamId64_key" ON "ExcludedPlayer"("steamId64");

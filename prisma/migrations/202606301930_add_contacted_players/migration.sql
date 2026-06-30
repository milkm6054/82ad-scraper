CREATE TABLE "ContactedPlayer" (
    "id" TEXT NOT NULL,
    "steamId64" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactedPlayer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactedPlayer_steamId64_key" ON "ContactedPlayer"("steamId64");

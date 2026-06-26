CREATE TABLE "PollState" (
    "id" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 120,
    "lastStartedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PollState_pkey" PRIMARY KEY ("id")
);

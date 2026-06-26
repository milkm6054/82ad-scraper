ALTER TABLE "SpottedPlayer"
ADD COLUMN "hllRecordsKpm180" DOUBLE PRECISION,
ADD COLUMN "hllRecordsStatError" TEXT,
ADD COLUMN "hllRecordsStatFetchedAt" TIMESTAMP(3);

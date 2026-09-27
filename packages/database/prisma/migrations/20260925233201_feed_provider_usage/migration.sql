-- CreateTable
CREATE TABLE "FeedProviderUsage" (
    "provider" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedProviderUsage_pkey" PRIMARY KEY ("provider","day")
);

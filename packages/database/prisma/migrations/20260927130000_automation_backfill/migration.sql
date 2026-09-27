-- Data backfill for rows created before the automation layer (no schema change).

-- Cross-source identity used by the execution idempotency key and the "already applied" rule check.
UPDATE "Application" a
SET "canonicalJobKey" = COALESCE(j."matchKey", 'dedupe:' || j."dedupeKey")
FROM "Job" j
WHERE a."jobId" = j."id" AND a."canonicalJobKey" IS NULL;

-- Screening drafts written before verified answer resolution: only answers the generator could confirm from
-- verified facts count as resolved; the "I cannot confirm..." placeholders must never be submitted.
UPDATE "ScreeningAnswerDraft"
SET "resolved" = "canConfirm",
    "answerSource" = CASE WHEN "canConfirm" THEN 'GENERATED'::"AnswerSource" ELSE 'UNKNOWN'::"AnswerSource" END
WHERE "questionKey" IS NULL;

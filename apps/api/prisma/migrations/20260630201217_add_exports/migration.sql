-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('docx', 'pdf', 'csv');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_sub" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID,
    "format" "ExportFormat" NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'pending',
    "file_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exports_user_idx" ON "exports"("user_sub", "created_at" DESC);

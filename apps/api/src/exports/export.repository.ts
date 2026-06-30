import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ExportFormat = 'docx' | 'pdf' | 'csv';
export type ExportStatus = 'pending' | 'ready' | 'failed';

export interface ExportRecord {
  id: string;
  userSub: string;
  conversationId: string;
  messageId: string | null;
  format: ExportFormat;
  status: ExportStatus;
  fileId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateExportInput {
  userSub: string;
  conversationId: string;
  messageId?: string | null;
  format: ExportFormat;
}

@Injectable()
export class ExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A fresh export starts pending; the job fills in fileId or error later. */
  async create(input: CreateExportInput): Promise<ExportRecord> {
    const row = await this.prisma.export.create({
      data: {
        userSub: input.userSub,
        conversationId: input.conversationId,
        messageId: input.messageId ?? null,
        format: input.format,
      },
    });
    return toRecord(row);
  }

  /** Ownership is part of the lookup — a foreign export is "not found". */
  async get(id: string, userSub: string): Promise<ExportRecord | null> {
    const row = await this.prisma.export.findFirst({ where: { id, userSub } });
    return row ? toRecord(row) : null;
  }

  /** Job succeeded: link the encrypted file and flip to ready. */
  async markReady(id: string, fileId: string): Promise<void> {
    await this.prisma.export.update({
      where: { id },
      data: { status: 'ready', fileId, error: null, updatedAt: new Date() },
    });
  }

  /** Job failed: record the reason, leave fileId null. */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.export.update({
      where: { id },
      data: { status: 'failed', error, updatedAt: new Date() },
    });
  }
}

function toRecord(row: {
  id: string;
  userSub: string;
  conversationId: string;
  messageId: string | null;
  format: string;
  status: string;
  fileId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ExportRecord {
  return {
    id: row.id,
    userSub: row.userSub,
    conversationId: row.conversationId,
    messageId: row.messageId,
    format: row.format as ExportFormat,
    status: row.status as ExportStatus,
    fileId: row.fileId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

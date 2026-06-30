import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface FileRecord {
  id: string;
  userSub: string;
  name: string;
  mime: string;
  sizeBytes: number;
  objectKey: string;
  iv: Buffer;
  authTag: Buffer;
  createdAt: Date;
}

@Injectable()
export class FileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getWrappedDek(userSub: string): Promise<string | null> {
    const dek = await this.prisma.userDek.findUnique({ where: { userSub } });
    return dek?.wrappedDek ?? null;
  }

  /** First-writer wins under concurrency; returns the winning wrapped DEK. */
  async saveWrappedDek(userSub: string, wrapped: string): Promise<string> {
    // Empty update = on conflict keep the existing DEK (first writer wins).
    const dek = await this.prisma.userDek.upsert({
      where: { userSub },
      create: { userSub, wrappedDek: wrapped },
      update: {},
    });
    return dek.wrappedDek;
  }

  async listWrappedDeks(): Promise<{ userSub: string; wrapped: string }[]> {
    const deks = await this.prisma.userDek.findMany();
    return deks.map((dek) => ({ userSub: dek.userSub, wrapped: dek.wrappedDek }));
  }

  async updateWrappedDek(userSub: string, wrapped: string): Promise<void> {
    await this.prisma.userDek.updateMany({
      where: { userSub },
      data: { wrappedDek: wrapped, updatedAt: new Date() },
    });
  }

  async insertFile(record: Omit<FileRecord, 'id' | 'createdAt'>): Promise<FileRecord> {
    const file = await this.prisma.file.create({
      data: {
        userSub: record.userSub,
        name: record.name,
        mime: record.mime,
        sizeBytes: record.sizeBytes,
        objectKey: record.objectKey,
        // Copy into a fresh Uint8Array — Prisma's Bytes input is
        // Uint8Array<ArrayBuffer>, while Node Buffer is Uint8Array<ArrayBufferLike>.
        iv: Uint8Array.from(record.iv),
        authTag: Uint8Array.from(record.authTag),
      },
    });
    return toRecord(file);
  }

  /** Ownership is part of the lookup — a foreign file is "not found". */
  async getFile(id: string, userSub: string): Promise<FileRecord | null> {
    const file = await this.prisma.file.findFirst({ where: { id, userSub } });
    return file ? toRecord(file) : null;
  }

  async listFiles(userSub: string): Promise<FileRecord[]> {
    const files = await this.prisma.file.findMany({
      where: { userSub },
      orderBy: { createdAt: 'desc' },
    });
    return files.map(toRecord);
  }
}

function toRecord(file: {
  id: string;
  userSub: string;
  name: string;
  mime: string;
  sizeBytes: number;
  objectKey: string;
  iv: Uint8Array;
  authTag: Uint8Array;
  createdAt: Date;
}): FileRecord {
  return {
    id: file.id,
    userSub: file.userSub,
    name: file.name,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    objectKey: file.objectKey,
    // Prisma returns Bytes as Uint8Array; callers expect Node Buffers.
    iv: Buffer.from(file.iv),
    authTag: Buffer.from(file.authTag),
    createdAt: file.createdAt,
  };
}

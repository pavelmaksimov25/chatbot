import {
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { decryptFile, encryptFile } from './file-crypto';
import { FileRepository } from './file.repository';
import type { FileRecord } from './file.repository';
import { ObjectStoreService } from './object-store.service';
import { VaultTransitService } from './vault-transit.service';

export const MAX_RAW_BYTES = 5 * 1024 * 1024; // 5MB raw upload cap
export const MAX_EXTRACTED_TOKENS = 25_000; // ~tokens post-extraction

// Vision-in allowed; everything else rejected outright (no silent coercion).
const ALLOWED_MIME = [
  /^text\//,
  /^application\/pdf$/,
  /^application\/json$/,
  /^image\/(png|jpeg|gif|webp)$/,
];

export interface FileView {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Envelope encryption orchestration (see DECISIONS.md, slice 14): per-user
 * DEK from Vault Transit's datakey endpoint, AES-256-GCM on the file bytes,
 * ciphertext to MinIO, wrapped DEK + nonce/tag in the DB. The plaintext DEK
 * lives only for the duration of one request.
 */
@Injectable()
export class FileService {
  constructor(
    private readonly vault: VaultTransitService,
    private readonly store: ObjectStoreService,
    private readonly files: FileRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FileService.name);
  }

  async upload(userSub: string, name: string, mime: string, content: Buffer): Promise<FileView> {
    // Caps are checked BEFORE anything persists; rejection leaves no trace.
    if (content.length > MAX_RAW_BYTES) {
      throw new PayloadTooLargeException(
        `file is too large — the limit is ${MAX_RAW_BYTES / (1024 * 1024)}MB ` +
          '(large-document chat is coming in v2)',
      );
    }
    if (!ALLOWED_MIME.some((p) => p.test(mime))) {
      throw new UnsupportedMediaTypeException(
        `unsupported file type ${mime} — text, PDF and images are accepted`,
      );
    }
    if (mime.startsWith('text/') || mime === 'application/json') {
      // ~4 chars per token; an estimate is enough for a hard guardrail.
      const estimatedTokens = Math.ceil(content.length / 4);
      if (estimatedTokens > MAX_EXTRACTED_TOKENS) {
        throw new PayloadTooLargeException(
          `file is too long (~${estimatedTokens} tokens) — the limit is ` +
            `${MAX_EXTRACTED_TOKENS} tokens (large-document chat is coming in v2)`,
        );
      }
    }

    const dek = await this.userDek(userSub);
    const encrypted = encryptFile(dek, content);
    const record = await this.files.insertFile({
      userSub,
      name,
      mime,
      sizeBytes: content.length,
      objectKey: `${encodeURIComponent(userSub)}/${crypto.randomUUID()}`,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
    });
    await this.store.put(record.objectKey, encrypted.ciphertext);
    this.logger.info({ fileId: record.id, sizeBytes: content.length }, 'file stored encrypted');
    return toView(record);
  }

  async download(userSub: string, fileId: string): Promise<{ meta: FileView; content: Buffer }> {
    const record = await this.files.getFile(fileId, userSub);
    if (!record) {
      throw new NotFoundException('file not found');
    }
    const dek = await this.userDek(userSub);
    const ciphertext = await this.store.get(record.objectKey);
    const content = decryptFile(dek, {
      ciphertext,
      iv: record.iv,
      authTag: record.authTag,
    });
    return { meta: toView(record), content };
  }

  async list(userSub: string): Promise<FileView[]> {
    return (await this.files.listFiles(userSub)).map(toView);
  }

  /** KEK rotation: new key version in Vault, every DEK re-wrapped — file ciphertext untouched. */
  async rotateKek(): Promise<{ rewrapped: number }> {
    await this.vault.rotateKek();
    const deks = await this.files.listWrappedDeks();
    for (const { userSub, wrapped } of deks) {
      const rewrapped = await this.vault.rewrapDek(wrapped);
      await this.files.updateWrappedDek(userSub, rewrapped);
    }
    this.logger.info({ rewrapped: deks.length }, 'KEK rotated, DEKs re-wrapped');
    return { rewrapped: deks.length };
  }

  /** Get-or-create the user's DEK; only the wrapped form is ever stored. */
  private async userDek(userSub: string): Promise<Buffer> {
    const existing = await this.files.getWrappedDek(userSub);
    if (existing) {
      return this.vault.unwrapDek(existing);
    }
    const generated = await this.vault.generateDek();
    const winner = await this.files.saveWrappedDek(userSub, generated.wrapped);
    // A concurrent first upload may have won the insert — honor that DEK.
    return winner === generated.wrapped ? generated.plaintext : this.vault.unwrapDek(winner);
  }
}

function toView(record: FileRecord): FileView {
  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt.toISOString(),
  };
}

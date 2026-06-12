import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Client } from 'minio';

const BUCKET = (): string => process.env.MINIO_BUCKET ?? 'chatbot-files';

/** MinIO wrapper — stores ONLY ciphertext; plaintext never reaches it. */
@Injectable()
export class ObjectStoreService implements OnModuleInit {
  private client?: Client;

  async onModuleInit(): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }
    const exists = await this.getClient().bucketExists(BUCKET());
    if (!exists) {
      await this.getClient().makeBucket(BUCKET());
    }
  }

  isConfigured(): boolean {
    return Boolean(
      process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY,
    );
  }

  async put(objectKey: string, ciphertext: Buffer): Promise<void> {
    await this.getClient().putObject(BUCKET(), objectKey, ciphertext);
  }

  async get(objectKey: string): Promise<Buffer> {
    const stream = await this.getClient().getObject(BUCKET(), objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private getClient(): Client {
    if (!this.client) {
      const url = new URL(process.env.MINIO_ENDPOINT!);
      this.client = new Client({
        endPoint: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        useSSL: url.protocol === 'https:',
        accessKey: process.env.MINIO_ACCESS_KEY!,
        secretKey: process.env.MINIO_SECRET_KEY!,
      });
    }
    return this.client;
  }
}

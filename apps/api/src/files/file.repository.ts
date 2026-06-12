import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

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

interface FileRow {
  id: string;
  user_sub: string;
  name: string;
  mime: string;
  size_bytes: number;
  object_key: string;
  iv: Buffer;
  auth_tag: Buffer;
  created_at: Date;
}

const COLUMNS = 'id, user_sub, name, mime, size_bytes, object_key, iv, auth_tag, created_at';

@Injectable()
export class FileRepository implements OnModuleInit {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_deks (
        user_sub    text PRIMARY KEY,
        wrapped_dek text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS files (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub    text NOT NULL,
        name        text NOT NULL,
        mime        text NOT NULL,
        size_bytes  integer NOT NULL,
        object_key  text NOT NULL,
        iv          bytea NOT NULL,
        auth_tag    bytea NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS files_user_idx ON files (user_sub, created_at DESC);
    `);
  }

  async getWrappedDek(userSub: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ wrapped_dek: string }>(
      'SELECT wrapped_dek FROM user_deks WHERE user_sub = $1',
      [userSub],
    );
    return rows[0]?.wrapped_dek ?? null;
  }

  /** First-writer wins under concurrency; returns the winning wrapped DEK. */
  async saveWrappedDek(userSub: string, wrapped: string): Promise<string> {
    const { rows } = await this.pool.query<{ wrapped_dek: string }>(
      `INSERT INTO user_deks (user_sub, wrapped_dek) VALUES ($1, $2)
       ON CONFLICT (user_sub) DO UPDATE SET user_sub = EXCLUDED.user_sub
       RETURNING wrapped_dek`,
      [userSub, wrapped],
    );
    return rows[0].wrapped_dek;
  }

  async listWrappedDeks(): Promise<{ userSub: string; wrapped: string }[]> {
    const { rows } = await this.pool.query<{ user_sub: string; wrapped_dek: string }>(
      'SELECT user_sub, wrapped_dek FROM user_deks',
    );
    return rows.map((r) => ({ userSub: r.user_sub, wrapped: r.wrapped_dek }));
  }

  async updateWrappedDek(userSub: string, wrapped: string): Promise<void> {
    await this.pool.query(
      'UPDATE user_deks SET wrapped_dek = $2, updated_at = now() WHERE user_sub = $1',
      [userSub, wrapped],
    );
  }

  async insertFile(record: Omit<FileRecord, 'id' | 'createdAt'>): Promise<FileRecord> {
    const { rows } = await this.pool.query<FileRow>(
      `INSERT INTO files (user_sub, name, mime, size_bytes, object_key, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        record.userSub,
        record.name,
        record.mime,
        record.sizeBytes,
        record.objectKey,
        record.iv,
        record.authTag,
      ],
    );
    return toRecord(rows[0]);
  }

  /** Ownership is part of the lookup — a foreign file is "not found". */
  async getFile(id: string, userSub: string): Promise<FileRecord | null> {
    const { rows } = await this.pool.query<FileRow>(
      `SELECT ${COLUMNS} FROM files WHERE id = $1 AND user_sub = $2`,
      [id, userSub],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listFiles(userSub: string): Promise<FileRecord[]> {
    const { rows } = await this.pool.query<FileRow>(
      `SELECT ${COLUMNS} FROM files WHERE user_sub = $1 ORDER BY created_at DESC`,
      [userSub],
    );
    return rows.map(toRecord);
  }
}

function toRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    userSub: row.user_sub,
    name: row.name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    objectKey: row.object_key,
    iv: row.iv,
    authTag: row.auth_tag,
    createdAt: row.created_at,
  };
}

import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface ProfileRecord {
  sub: string;
  email: string;
  displayName: string;
  preferences: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface ProfileRow {
  sub: string;
  email: string;
  display_name: string;
  preferences: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const RETURNING = 'sub, email, display_name, preferences, created_at, updated_at';

@Injectable()
export class ProfileRepository implements OnModuleInit {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Tracer-bullet migration: idempotent DDL on boot. Replace with a real
  // migration runner once the schema stops being a single table.
  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        sub          text PRIMARY KEY,
        email        text NOT NULL,
        display_name text NOT NULL,
        preferences  jsonb NOT NULL DEFAULT '{}',
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  /** Get-or-create. Re-login refreshes the IdP email but never the chosen display name. */
  async ensure(sub: string, email: string, displayName: string): Promise<ProfileRecord> {
    const { rows } = await this.pool.query<ProfileRow>(
      `INSERT INTO user_profiles (sub, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (sub) DO UPDATE
         SET email = EXCLUDED.email,
             updated_at = CASE WHEN user_profiles.email IS DISTINCT FROM EXCLUDED.email
                               THEN now() ELSE user_profiles.updated_at END
       RETURNING ${RETURNING}`,
      [sub, email, displayName],
    );
    return toRecord(rows[0]);
  }

  async get(sub: string): Promise<ProfileRecord | null> {
    const { rows } = await this.pool.query<ProfileRow>(
      `SELECT ${RETURNING} FROM user_profiles WHERE sub = $1`,
      [sub],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async update(
    sub: string,
    patch: { displayName?: string; preferences?: Record<string, unknown> },
  ): Promise<ProfileRecord | null> {
    const { rows } = await this.pool.query<ProfileRow>(
      `UPDATE user_profiles
         SET display_name = COALESCE($2, display_name),
             preferences  = COALESCE($3::jsonb, preferences),
             updated_at   = now()
       WHERE sub = $1
       RETURNING ${RETURNING}`,
      [
        sub,
        patch.displayName ?? null,
        patch.preferences ? JSON.stringify(patch.preferences) : null,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

function toRecord(row: ProfileRow): ProfileRecord {
  return {
    sub: row.sub,
    email: row.email,
    displayName: row.display_name,
    preferences: row.preferences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

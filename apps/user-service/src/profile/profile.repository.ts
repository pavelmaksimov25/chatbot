import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class ProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get-or-create. Re-login refreshes the IdP email but never the chosen
   * display name — and only bumps updated_at when the email actually changed.
   * That conditional upsert is Postgres-specific, so it stays raw SQL.
   */
  async ensure(sub: string, email: string, displayName: string): Promise<ProfileRecord> {
    const rows = await this.prisma.$queryRaw<ProfileRow[]>`
      INSERT INTO user_profiles (sub, email, display_name)
      VALUES (${sub}, ${email}, ${displayName})
      ON CONFLICT (sub) DO UPDATE
        SET email = EXCLUDED.email,
            updated_at = CASE WHEN user_profiles.email IS DISTINCT FROM EXCLUDED.email
                              THEN now() ELSE user_profiles.updated_at END
      RETURNING sub, email, display_name, preferences, created_at, updated_at`;
    return fromRow(rows[0]);
  }

  async get(sub: string): Promise<ProfileRecord | null> {
    const profile = await this.prisma.userProfile.findUnique({ where: { sub } });
    return profile ? fromModel(profile) : null;
  }

  async update(
    sub: string,
    patch: { displayName?: string; preferences?: Record<string, unknown> },
  ): Promise<ProfileRecord | null> {
    try {
      const profile = await this.prisma.userProfile.update({
        where: { sub },
        data: {
          ...(patch.displayName !== undefined && { displayName: patch.displayName }),
          ...(patch.preferences !== undefined && {
            preferences: patch.preferences as Prisma.InputJsonValue,
          }),
          updatedAt: new Date(),
        },
      });
      return fromModel(profile);
    } catch (err) {
      // P2025 = record to update not found — a missing sub is "not found".
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }
}

function fromRow(row: ProfileRow): ProfileRecord {
  return {
    sub: row.sub,
    email: row.email,
    displayName: row.display_name,
    preferences: row.preferences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromModel(model: {
  sub: string;
  email: string;
  displayName: string;
  preferences: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): ProfileRecord {
  return {
    sub: model.sub,
    email: model.email,
    displayName: model.displayName,
    preferences: (model.preferences ?? {}) as Record<string, unknown>,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

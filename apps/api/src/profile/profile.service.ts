import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import type Redis from 'ioredis';
import { VALKEY } from '../cache/cache.module';
import { USER_SERVICE_GRPC } from '../grpc/user-service-client.module';

export interface Profile {
  sub: string;
  email: string;
  displayName: string;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProfilePatch {
  displayName?: string;
  preferences?: Record<string, unknown>;
}

interface ProfileMessage {
  sub: string;
  email: string;
  displayName: string;
  preferencesJson: string;
  createdAt: string;
  updatedAt: string;
}

interface UserServiceClient {
  ensureProfile(request: {
    sub: string;
    email: string;
    displayName: string;
  }): Observable<ProfileMessage>;
  getProfile(request: { sub: string }): Observable<ProfileMessage>;
  updateProfile(request: {
    sub: string;
    displayName?: string;
    preferencesJson?: string;
  }): Observable<ProfileMessage>;
}

// The chat hot path reads the profile per message — it must hit Valkey, not
// gRPC. The TTL is a safety net; writes go through this service and refresh
// the entry themselves.
const CACHE_TTL_SECONDS = 300;

@Injectable()
export class ProfileService implements OnModuleInit {
  private userService!: UserServiceClient;

  constructor(
    @Inject(USER_SERVICE_GRPC) private readonly client: ClientGrpc,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  onModuleInit(): void {
    this.userService = this.client.getService<UserServiceClient>('UserService');
  }

  async ensure(sub: string, email: string, displayName: string): Promise<Profile> {
    const message = await firstValueFrom(
      this.userService.ensureProfile({ sub, email, displayName }),
    );
    return this.cache(toProfile(message));
  }

  /** Cache-first read; gRPC only on miss. */
  async get(sub: string): Promise<Profile> {
    const cached = await this.valkey.get(cacheKey(sub));
    if (cached) {
      return JSON.parse(cached) as Profile;
    }
    const message = await firstValueFrom(this.userService.getProfile({ sub }));
    return this.cache(toProfile(message));
  }

  async update(sub: string, patch: ProfilePatch): Promise<Profile> {
    const message = await firstValueFrom(
      this.userService.updateProfile({
        sub,
        ...(patch.displayName !== undefined && { displayName: patch.displayName }),
        ...(patch.preferences !== undefined && {
          preferencesJson: JSON.stringify(patch.preferences),
        }),
      }),
    );
    // Write-through: the stale entry is replaced, not just dropped, so the
    // next read cannot race a concurrent miss into resurrecting old data.
    return this.cache(toProfile(message));
  }

  private async cache(profile: Profile): Promise<Profile> {
    await this.valkey.setex(cacheKey(profile.sub), CACHE_TTL_SECONDS, JSON.stringify(profile));
    return profile;
  }
}

function cacheKey(sub: string): string {
  return `profile:${sub}`;
}

function toProfile(message: ProfileMessage): Profile {
  return {
    sub: message.sub,
    email: message.email,
    displayName: message.displayName,
    preferences: JSON.parse(message.preferencesJson || '{}') as Record<string, unknown>,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

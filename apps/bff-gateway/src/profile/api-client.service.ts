import { Injectable } from '@nestjs/common';

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

/** An api response the BFF should translate, carrying the upstream status. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Typed client for the api's internal /profiles surface. */
@Injectable()
export class ProfileApiClient {
  async getProfile(sub: string): Promise<Profile | null> {
    const res = await fetch(this.url(`/profiles/${encodeURIComponent(sub)}`));
    if (res.status === 404) {
      return null;
    }
    return this.parse(res);
  }

  async ensureProfile(sub: string, email: string, displayName: string): Promise<Profile> {
    const res = await fetch(this.url('/profiles/ensure'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub, email, displayName }),
    });
    return this.parse(res);
  }

  async updateProfile(sub: string, patch: ProfilePatch): Promise<Profile> {
    const res = await fetch(this.url(`/profiles/${encodeURIComponent(sub)}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return this.parse(res);
  }

  private url(path: string): string {
    return `${process.env.API_URL ?? 'http://localhost:3001'}${path}`;
  }

  private async parse(res: Response): Promise<Profile> {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ApiRequestError(res.status, body.message ?? `api returned ${res.status}`);
    }
    return (await res.json()) as Profile;
  }
}

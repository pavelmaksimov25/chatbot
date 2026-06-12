import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import '../auth/session.types';
import { ApiRequestError, ProfileApiClient } from './api-client.service';
import type { Profile, ProfilePatch } from './api-client.service';

interface UpdateMeBody {
  displayName?: unknown;
  preferences?: unknown;
}

/**
 * The SPA's profile surface. The session cookie is the only credential; the
 * Auth0 sub never travels from the browser — it comes from the session.
 */
@Controller('me')
export class ProfileController {
  constructor(private readonly api: ProfileApiClient) {}

  @Get()
  async me(@Req() req: Request): Promise<Profile> {
    const user = this.requireUser(req);
    try {
      const profile = await this.api.getProfile(user.sub);
      if (profile) {
        return profile;
      }
      // Login-time provisioning is best-effort; this is the durable fallback.
      return await this.api.ensureProfile(user.sub, user.email, user.name ?? user.email);
    } catch (err) {
      throw this.translate(err);
    }
  }

  @Patch()
  async update(@Req() req: Request, @Body() body: UpdateMeBody): Promise<Profile> {
    // CSRF is enforced by the global guard before we get here.
    const user = this.requireUser(req);
    const patch: ProfilePatch = {};
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string') {
        throw new BadRequestException('displayName must be a string');
      }
      patch.displayName = body.displayName;
    }
    if (body.preferences !== undefined) {
      if (
        typeof body.preferences !== 'object' ||
        body.preferences === null ||
        Array.isArray(body.preferences)
      ) {
        throw new BadRequestException('preferences must be an object');
      }
      patch.preferences = body.preferences as Record<string, unknown>;
    }
    try {
      return await this.api.updateProfile(user.sub, patch);
    } catch (err) {
      throw this.translate(err);
    }
  }

  private requireUser(req: Request): NonNullable<typeof req.session.user> {
    if (!req.session.user) {
      throw new UnauthorizedException();
    }
    return req.session.user;
  }

  private translate(err: unknown): Error {
    if (err instanceof ApiRequestError) {
      if (err.status === 400) {
        return new BadRequestException(err.message);
      }
      if (err.status === 404) {
        return new NotFoundException(err.message);
      }
    }
    return new BadGatewayException('profile service unavailable');
  }
}

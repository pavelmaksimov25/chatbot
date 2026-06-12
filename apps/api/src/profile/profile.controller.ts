import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { ProfileService } from './profile.service';
import type { Profile } from './profile.service';

interface EnsureProfileBody {
  sub?: unknown;
  email?: unknown;
  displayName?: unknown;
}

interface UpdateProfileBody {
  displayName?: unknown;
  preferences?: unknown;
}

// Internal surface for the BFF — never exposed through Caddy directly.
@Controller('profiles')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Post('ensure')
  async ensure(@Body() body: EnsureProfileBody): Promise<Profile> {
    const sub = requireString(body.sub, 'sub');
    const email = requireString(body.email, 'email');
    const displayName = requireString(body.displayName, 'displayName');
    return this.call(() => this.profiles.ensure(sub, email, displayName));
  }

  @Get(':sub')
  get(@Param('sub') sub: string): Promise<Profile> {
    return this.call(() => this.profiles.get(sub));
  }

  @Patch(':sub')
  async update(@Param('sub') sub: string, @Body() body: UpdateProfileBody): Promise<Profile> {
    const patch: { displayName?: string; preferences?: Record<string, unknown> } = {};
    if (body.displayName !== undefined) {
      patch.displayName = requireString(body.displayName, 'displayName');
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
    return this.call(() => this.profiles.update(sub, patch));
  }

  /** Translate gRPC status codes into the HTTP vocabulary the BFF expects. */
  private async call(fn: () => Promise<Profile>): Promise<Profile> {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === status.NOT_FOUND) {
        throw new NotFoundException('profile not found');
      }
      if (code === status.INVALID_ARGUMENT) {
        throw new BadRequestException(
          (err as Error).message?.replace(/^\d+ INVALID_ARGUMENT: /, ''),
        );
      }
      throw new BadGatewayException('user-service unavailable');
    }
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException(`${name} must be a non-empty string`);
  }
  return value;
}

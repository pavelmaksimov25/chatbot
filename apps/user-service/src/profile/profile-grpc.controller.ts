import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { PinoLogger } from 'nestjs-pino';
import { ProfileRepository } from './profile.repository';
import type { ProfileRecord } from './profile.repository';

export interface ProfileMessage {
  sub: string;
  email: string;
  displayName: string;
  preferencesJson: string;
  createdAt: string;
  updatedAt: string;
}

interface EnsureProfileRequest {
  sub?: string;
  email?: string;
  displayName?: string;
}

interface GetProfileRequest {
  sub?: string;
}

interface UpdateProfileRequest {
  sub?: string;
  displayName?: string;
  preferencesJson?: string;
}

const MAX_DISPLAY_NAME = 100;

@Controller()
export class ProfileGrpcController {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProfileGrpcController.name);
  }

  @GrpcMethod('UserService', 'EnsureProfile')
  async ensureProfile(request: EnsureProfileRequest): Promise<ProfileMessage> {
    const sub = requireField(request.sub, 'sub');
    const email = requireField(request.email, 'email');
    const displayName = validDisplayName(requireField(request.displayName, 'display_name'));
    const profile = await this.profiles.ensure(sub, email, displayName);
    // pino-http only covers HTTP — log gRPC calls explicitly so they carry
    // the trace id too.
    this.logger.info({ sub }, 'grpc ensure profile');
    return toMessage(profile);
  }

  @GrpcMethod('UserService', 'GetProfile')
  async getProfile(request: GetProfileRequest): Promise<ProfileMessage> {
    const sub = requireField(request.sub, 'sub');
    const profile = await this.profiles.get(sub);
    if (!profile) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'profile not found' });
    }
    this.logger.info({ sub }, 'grpc get profile');
    return toMessage(profile);
  }

  @GrpcMethod('UserService', 'UpdateProfile')
  async updateProfile(request: UpdateProfileRequest): Promise<ProfileMessage> {
    const sub = requireField(request.sub, 'sub');
    const patch: { displayName?: string; preferences?: Record<string, unknown> } = {};
    if (request.displayName !== undefined) {
      patch.displayName = validDisplayName(request.displayName);
    }
    if (request.preferencesJson !== undefined) {
      patch.preferences = parsePreferences(request.preferencesJson);
    }
    if (patch.displayName === undefined && patch.preferences === undefined) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'nothing to update' });
    }
    const profile = await this.profiles.update(sub, patch);
    if (!profile) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'profile not found' });
    }
    this.logger.info({ sub }, 'grpc update profile');
    return toMessage(profile);
  }
}

function requireField(value: string | undefined, name: string): string {
  if (!value) {
    throw new RpcException({ code: status.INVALID_ARGUMENT, message: `${name} is required` });
  }
  return value;
}

function validDisplayName(raw: string): string {
  const displayName = raw.trim();
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: `display_name must be 1-${MAX_DISPLAY_NAME} characters`,
    });
  }
  return displayName;
}

function parsePreferences(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'preferences must be JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: 'preferences must be a JSON object',
    });
  }
  return parsed as Record<string, unknown>;
}

function toMessage(profile: ProfileRecord): ProfileMessage {
  return {
    sub: profile.sub,
    email: profile.email,
    displayName: profile.displayName,
    preferencesJson: JSON.stringify(profile.preferences),
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

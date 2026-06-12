import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { PinoLogger } from 'nestjs-pino';
import { ProfileGrpcController } from './profile-grpc.controller';
import { ProfileRepository } from './profile.repository';
import type { ProfileRecord } from './profile.repository';

const NOW = new Date('2026-06-12T00:00:00.000Z');

function record(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    sub: 'auth0|123',
    email: 'user@example.com',
    displayName: 'User',
    preferences: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('ProfileGrpcController', () => {
  let controller: ProfileGrpcController;
  let repository: jest.Mocked<Pick<ProfileRepository, 'ensure' | 'get' | 'update'>>;

  beforeEach(async () => {
    repository = {
      ensure: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProfileGrpcController],
      providers: [
        { provide: ProfileRepository, useValue: repository },
        {
          provide: PinoLogger,
          useValue: { setContext: jest.fn(), info: jest.fn() },
        },
      ],
    }).compile();
    controller = moduleRef.get(ProfileGrpcController);
  });

  async function grpcCode(promise: Promise<unknown>): Promise<number | undefined> {
    try {
      await promise;
      return undefined;
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      return ((err as RpcException).getError() as { code: number }).code;
    }
  }

  describe('EnsureProfile', () => {
    it('creates the profile and serializes it onto the wire', async () => {
      repository.ensure.mockResolvedValue(record({ preferences: { theme: 'dark' } }));

      const reply = await controller.ensureProfile({
        sub: 'auth0|123',
        email: 'user@example.com',
        displayName: '  User  ',
      });

      expect(repository.ensure).toHaveBeenCalledWith('auth0|123', 'user@example.com', 'User');
      expect(reply).toEqual({
        sub: 'auth0|123',
        email: 'user@example.com',
        displayName: 'User',
        preferencesJson: '{"theme":"dark"}',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    });

    it('rejects a missing sub with INVALID_ARGUMENT', async () => {
      await expect(
        grpcCode(controller.ensureProfile({ email: 'a@b.c', displayName: 'A' })),
      ).resolves.toBe(status.INVALID_ARGUMENT);
      expect(repository.ensure).not.toHaveBeenCalled();
    });

    it('rejects a blank display name with INVALID_ARGUMENT', async () => {
      await expect(
        grpcCode(controller.ensureProfile({ sub: 's', email: 'a@b.c', displayName: '   ' })),
      ).resolves.toBe(status.INVALID_ARGUMENT);
    });
  });

  describe('GetProfile', () => {
    it('returns the profile when it exists', async () => {
      repository.get.mockResolvedValue(record());
      const reply = await controller.getProfile({ sub: 'auth0|123' });
      expect(reply.sub).toBe('auth0|123');
    });

    it('maps a missing profile to NOT_FOUND', async () => {
      repository.get.mockResolvedValue(null);
      await expect(grpcCode(controller.getProfile({ sub: 'nope' }))).resolves.toBe(
        status.NOT_FOUND,
      );
    });
  });

  describe('UpdateProfile', () => {
    it('passes a partial patch through and parses preferences', async () => {
      repository.update.mockResolvedValue(record({ displayName: 'New' }));

      await controller.updateProfile({
        sub: 'auth0|123',
        displayName: 'New',
        preferencesJson: '{"theme":"light"}',
      });

      expect(repository.update).toHaveBeenCalledWith('auth0|123', {
        displayName: 'New',
        preferences: { theme: 'light' },
      });
    });

    it('rejects malformed preferences JSON with INVALID_ARGUMENT', async () => {
      await expect(
        grpcCode(controller.updateProfile({ sub: 's', preferencesJson: 'not json' })),
      ).resolves.toBe(status.INVALID_ARGUMENT);
    });

    it('rejects a non-object preferences value with INVALID_ARGUMENT', async () => {
      await expect(
        grpcCode(controller.updateProfile({ sub: 's', preferencesJson: '[1,2]' })),
      ).resolves.toBe(status.INVALID_ARGUMENT);
    });

    it('rejects an empty patch with INVALID_ARGUMENT', async () => {
      await expect(grpcCode(controller.updateProfile({ sub: 's' }))).resolves.toBe(
        status.INVALID_ARGUMENT,
      );
    });

    it('maps a missing profile to NOT_FOUND', async () => {
      repository.update.mockResolvedValue(null);
      await expect(
        grpcCode(controller.updateProfile({ sub: 'nope', displayName: 'X' })),
      ).resolves.toBe(status.NOT_FOUND);
    });
  });
});

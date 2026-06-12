import { Test } from '@nestjs/testing';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import type Redis from 'ioredis';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { VALKEY } from '../cache/cache.module';
import { USER_SERVICE_GRPC } from '../grpc/user-service-client.module';

const WIRE_PROFILE = {
  sub: 'auth0|123',
  email: 'user@example.com',
  displayName: 'User',
  preferencesJson: '{"theme":"dark"}',
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
};

const PROFILE = {
  sub: 'auth0|123',
  email: 'user@example.com',
  displayName: 'User',
  preferences: { theme: 'dark' },
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
};

function grpcError(code: number): Error & { code: number } {
  return Object.assign(new Error(`${code} grpc error`), { code });
}

describe('ProfileController', () => {
  let controller: ProfileController;
  let grpc: {
    ensureProfile: jest.Mock;
    getProfile: jest.Mock;
    updateProfile: jest.Mock;
  };
  let store: Map<string, string>;

  beforeEach(async () => {
    grpc = {
      ensureProfile: jest.fn().mockReturnValue(of(WIRE_PROFILE)),
      getProfile: jest.fn().mockReturnValue(of(WIRE_PROFILE)),
      updateProfile: jest.fn().mockReturnValue(of(WIRE_PROFILE)),
    };
    store = new Map();
    const fakeValkey = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      setex: jest.fn((key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
    } as unknown as Redis;

    const moduleRef = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [
        ProfileService,
        { provide: VALKEY, useValue: fakeValkey },
        { provide: USER_SERVICE_GRPC, useValue: { getService: () => grpc } },
      ],
    }).compile();
    moduleRef.get(ProfileService).onModuleInit();
    controller = moduleRef.get(ProfileController);
  });

  describe('GET /profiles/:sub', () => {
    it('falls back to gRPC on cache miss and populates the cache', async () => {
      await expect(controller.get('auth0|123')).resolves.toEqual(PROFILE);
      expect(grpc.getProfile).toHaveBeenCalledTimes(1);
      expect(store.get('profile:auth0|123')).toBe(JSON.stringify(PROFILE));
    });

    it('serves a cache hit without any gRPC call', async () => {
      store.set('profile:auth0|123', JSON.stringify(PROFILE));
      await expect(controller.get('auth0|123')).resolves.toEqual(PROFILE);
      expect(grpc.getProfile).not.toHaveBeenCalled();
    });

    it('maps gRPC NOT_FOUND to 404', async () => {
      grpc.getProfile.mockReturnValue(throwError(() => grpcError(status.NOT_FOUND)));
      await expect(controller.get('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a dead user-service to 502', async () => {
      grpc.getProfile.mockReturnValue(throwError(() => grpcError(status.UNAVAILABLE)));
      await expect(controller.get('auth0|123')).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('POST /profiles/ensure', () => {
    it('provisions through gRPC and caches the result', async () => {
      await expect(
        controller.ensure({ sub: 'auth0|123', email: 'user@example.com', displayName: 'User' }),
      ).resolves.toEqual(PROFILE);
      expect(grpc.ensureProfile).toHaveBeenCalledWith({
        sub: 'auth0|123',
        email: 'user@example.com',
        displayName: 'User',
      });
      expect(store.has('profile:auth0|123')).toBe(true);
    });

    it('rejects a missing field with 400 before any gRPC call', async () => {
      await expect(
        controller.ensure({ sub: 'auth0|123', email: 'user@example.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(grpc.ensureProfile).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /profiles/:sub', () => {
    it('updates through gRPC and overwrites the cached entry', async () => {
      store.set('profile:auth0|123', JSON.stringify({ ...PROFILE, displayName: 'Stale' }));
      const updated = { ...WIRE_PROFILE, displayName: 'Fresh' };
      grpc.updateProfile.mockReturnValue(of(updated));

      await expect(controller.update('auth0|123', { displayName: 'Fresh' })).resolves.toMatchObject(
        { displayName: 'Fresh' },
      );
      expect(grpc.updateProfile).toHaveBeenCalledWith({ sub: 'auth0|123', displayName: 'Fresh' });
      expect(JSON.parse(store.get('profile:auth0|123')!)).toMatchObject({
        displayName: 'Fresh',
      });
    });

    it('serializes preferences for the wire', async () => {
      await controller.update('auth0|123', { preferences: { theme: 'light' } });
      expect(grpc.updateProfile).toHaveBeenCalledWith({
        sub: 'auth0|123',
        preferencesJson: '{"theme":"light"}',
      });
    });

    it('rejects array preferences with 400', async () => {
      await expect(controller.update('auth0|123', { preferences: [1, 2] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(grpc.updateProfile).not.toHaveBeenCalled();
    });

    it('maps gRPC INVALID_ARGUMENT to 400', async () => {
      grpc.updateProfile.mockReturnValue(throwError(() => grpcError(status.INVALID_ARGUMENT)));
      await expect(controller.update('auth0|123', { displayName: 'x' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

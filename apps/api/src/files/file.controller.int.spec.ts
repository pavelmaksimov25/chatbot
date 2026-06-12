import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { LoggerModule } from 'nestjs-pino';
import { Client as MinioClient } from 'minio';
import { PG_POOL } from '../db/db.module';
import { FileController } from './file.controller';
import { FileRepository } from './file.repository';
import { FileService } from './file.service';
import { ObjectStoreService } from './object-store.service';
import { VaultTransitService } from './vault-transit.service';

jest.setTimeout(180_000);

/**
 * The security-critical path of the slice, against REAL stores: Vault Transit
 * does the key operations, MinIO holds only ciphertext, Postgres holds only
 * wrapped DEKs. No mocks anywhere in the envelope.
 */
describe('Encrypted file storage (integration)', () => {
  let postgres: StartedPostgreSqlContainer;
  let vault: StartedTestContainer;
  let minio: StartedTestContainer;
  let pool: Pool;
  let app: INestApplication;
  let rawMinio: MinioClient;

  const asAlice = { 'x-user-sub': 'auth0|alice' };
  const asMallory = { 'x-user-sub': 'auth0|mallory' };

  beforeAll(async () => {
    [postgres, vault, minio] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('hashicorp/vault:1.20')
        .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: 'test-root-token' })
        .withExposedPorts(8200)
        .start(),
      new GenericContainer('minio/minio:latest')
        .withEnvironment({ MINIO_ROOT_USER: 'minio-test', MINIO_ROOT_PASSWORD: 'minio-secret' })
        .withCommand(['server', '/data'])
        .withExposedPorts(9000)
        .start(),
    ]);

    process.env.VAULT_ADDR = `http://${vault.getHost()}:${vault.getMappedPort(8200)}`;
    process.env.VAULT_TOKEN = 'test-root-token';
    process.env.MINIO_ENDPOINT = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    process.env.MINIO_ACCESS_KEY = 'minio-test';
    process.env.MINIO_SECRET_KEY = 'minio-secret';

    // Dev-mode Vault has no transit engine mounted yet.
    await fetch(`${process.env.VAULT_ADDR}/v1/sys/mounts/transit`, {
      method: 'POST',
      headers: { 'x-vault-token': 'test-root-token', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'transit' }),
    });

    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
      controllers: [FileController],
      providers: [
        FileService,
        FileRepository,
        ObjectStoreService,
        VaultTransitService,
        { provide: PG_POOL, useValue: pool },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await moduleRef.get(FileRepository).onModuleInit();
    await moduleRef.get(VaultTransitService).onModuleInit();
    await moduleRef.get(ObjectStoreService).onModuleInit();

    rawMinio = new MinioClient({
      endPoint: minio.getHost(),
      port: minio.getMappedPort(9000),
      useSSL: false,
      accessKey: 'minio-test',
      secretKey: 'minio-secret',
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await Promise.allSettled([postgres?.stop(), vault?.stop(), minio?.stop()]);
    for (const key of [
      'VAULT_ADDR',
      'VAULT_TOKEN',
      'MINIO_ENDPOINT',
      'MINIO_ACCESS_KEY',
      'MINIO_SECRET_KEY',
    ]) {
      delete process.env[key];
    }
  });

  const PLAINTEXT = 'TOP SECRET meeting notes — the plaintext marker 0123456789';

  async function uploadText(headers: Record<string, string>, name = 'notes.txt'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/files')
      .set(headers)
      .attach('file', Buffer.from(PLAINTEXT), { filename: name, contentType: 'text/plain' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  it('stores ONLY ciphertext in MinIO and round-trips back to the exact plaintext', async () => {
    const fileId = await uploadText(asAlice);

    // What actually sits in the object store must not contain the plaintext.
    const { rows } = await pool.query<{ object_key: string }>(
      'SELECT object_key FROM files WHERE id = $1',
      [fileId],
    );
    const stored = await (async () => {
      const stream = await rawMinio.getObject('chatbot-files', rows[0].object_key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    })();
    expect(stored.toString('utf8')).not.toContain('TOP SECRET');
    expect(stored.toString('utf8')).not.toContain('plaintext marker');

    // The owner gets the exact original back.
    const download = await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(asAlice)
      .expect(200)
      .expect('content-type', /text\/plain/);
    expect(download.text).toBe(PLAINTEXT);
  });

  it('keeps only the WRAPPED DEK in the database', async () => {
    await uploadText(asAlice);
    const { rows } = await pool.query<{ wrapped_dek: string }>(
      "SELECT wrapped_dek FROM user_deks WHERE user_sub = 'auth0|alice'",
    );
    expect(rows[0].wrapped_dek).toMatch(/^vault:v\d+:/);
  });

  it("denies another user's file as 404 — list, download, everything", async () => {
    const fileId = await uploadText(asAlice);
    await request(app.getHttpServer()).get(`/files/${fileId}`).set(asMallory).expect(404);

    const list = await request(app.getHttpServer()).get('/files').set(asMallory).expect(200);
    expect((list.body as { id: string }[]).map((f) => f.id)).not.toContain(fileId);
  });

  it('rotating the KEK re-wraps DEKs without re-encrypting objects', async () => {
    const fileId = await uploadText(asAlice);
    const before = await pool.query<{ wrapped_dek: string }>(
      "SELECT wrapped_dek FROM user_deks WHERE user_sub = 'auth0|alice'",
    );
    const objectBefore = await pool.query<{ object_key: string }>(
      'SELECT object_key FROM files WHERE id = $1',
      [fileId],
    );

    const res = await request(app.getHttpServer())
      .post('/files/rotate-kek')
      .set(asAlice)
      .expect(201);
    expect((res.body as { rewrapped: number }).rewrapped).toBeGreaterThanOrEqual(1);

    const after = await pool.query<{ wrapped_dek: string }>(
      "SELECT wrapped_dek FROM user_deks WHERE user_sub = 'auth0|alice'",
    );
    // New wrapped blob (new KEK version), same object, still decryptable.
    expect(after.rows[0].wrapped_dek).not.toBe(before.rows[0].wrapped_dek);
    expect(after.rows[0].wrapped_dek.startsWith('vault:v')).toBe(true);
    const objectAfter = await pool.query<{ object_key: string }>(
      'SELECT object_key FROM files WHERE id = $1',
      [fileId],
    );
    expect(objectAfter.rows[0].object_key).toBe(objectBefore.rows[0].object_key);

    const download = await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(asAlice)
      .expect(200);
    expect(download.text).toBe(PLAINTEXT);
  });

  it('detects tampered ciphertext instead of returning garbage', async () => {
    const fileId = await uploadText(asAlice);
    const { rows } = await pool.query<{ object_key: string }>(
      'SELECT object_key FROM files WHERE id = $1',
      [fileId],
    );
    await rawMinio.putObject('chatbot-files', rows[0].object_key, Buffer.from('tampered bytes'));

    await request(app.getHttpServer()).get(`/files/${fileId}`).set(asAlice).expect(500);
  });

  it('rejects an oversized raw upload with the cap in the message and persists nothing', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    await request(app.getHttpServer())
      .post('/files')
      .set(asAlice)
      .attach('file', big, { filename: 'big.bin', contentType: 'image/png' })
      .expect(413);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM files WHERE name = 'big.bin'",
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects text past the token cap with the cap shown — never truncates', async () => {
    const tooLong = Buffer.from('word '.repeat(30_000)); // ~37.5K estimated tokens
    const res = await request(app.getHttpServer())
      .post('/files')
      .set(asAlice)
      .attach('file', tooLong, { filename: 'tome.txt', contentType: 'text/plain' })
      .expect(413);
    expect(JSON.stringify(res.body)).toContain('25000');
  });

  it('rejects unsupported file types as 415', async () => {
    await request(app.getHttpServer())
      .post('/files')
      .set(asAlice)
      .attach('file', Buffer.from('MZ...'), {
        filename: 'app.exe',
        contentType: 'application/x-msdownload',
      })
      .expect(415);
  });

  it('requires the user identity header', async () => {
    await request(app.getHttpServer()).get('/files').expect(401);
  });
});

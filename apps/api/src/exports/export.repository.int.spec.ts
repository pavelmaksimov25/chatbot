import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaService } from '../prisma/prisma.service';
import { ExportRepository } from './export.repository';

jest.setTimeout(120_000);

// apps/api — where prisma.config.ts + prisma/ live.
const PKG_ROOT = join(__dirname, '..', '..');
const PRISMA_BIN = join(PKG_ROOT, 'node_modules', '.bin', 'prisma');

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const MESSAGE_ID = '22222222-2222-2222-2222-222222222222';
const FILE_ID = '33333333-3333-3333-3333-333333333333';

describe('ExportRepository (postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let prisma: PrismaService;
  let repository: ExportRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    execFileSync(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: PKG_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'inherit',
    });
    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getPort());
    process.env.DB_USER = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.DB_NAME = container.getDatabase();
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new ExportRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE exports CASCADE');
  });

  it('creates a pending export owned by the user', async () => {
    const created = await repository.create({
      userSub: 'auth0|alice',
      conversationId: CONVERSATION_ID,
      format: 'pdf',
    });
    expect(created).toMatchObject({
      userSub: 'auth0|alice',
      conversationId: CONVERSATION_ID,
      messageId: null,
      format: 'pdf',
      status: 'pending',
      fileId: null,
      error: null,
    });
    await expect(repository.get(created.id, 'auth0|alice')).resolves.toMatchObject({
      id: created.id,
      status: 'pending',
    });
  });

  it('records an optional message scope', async () => {
    const created = await repository.create({
      userSub: 'auth0|alice',
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      format: 'csv',
    });
    expect(created.messageId).toBe(MESSAGE_ID);
    expect(created.format).toBe('csv');
  });

  it('hides foreign exports — ownership is part of the lookup', async () => {
    const created = await repository.create({
      userSub: 'auth0|alice',
      conversationId: CONVERSATION_ID,
      format: 'docx',
    });
    await expect(repository.get(created.id, 'auth0|mallory')).resolves.toBeNull();
  });

  it('marks an export ready, linking the encrypted file', async () => {
    const created = await repository.create({
      userSub: 'auth0|alice',
      conversationId: CONVERSATION_ID,
      format: 'pdf',
    });
    await repository.markReady(created.id, FILE_ID);

    const after = await repository.get(created.id, 'auth0|alice');
    expect(after).toMatchObject({ status: 'ready', fileId: FILE_ID, error: null });
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('marks an export failed with the reason, leaving fileId null', async () => {
    const created = await repository.create({
      userSub: 'auth0|alice',
      conversationId: CONVERSATION_ID,
      format: 'docx',
    });
    await repository.markFailed(created.id, 'renderer blew up');

    const after = await repository.get(created.id, 'auth0|alice');
    expect(after).toMatchObject({ status: 'failed', error: 'renderer blew up', fileId: null });
  });
});

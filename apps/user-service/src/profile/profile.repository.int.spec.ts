import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileRepository } from './profile.repository';

jest.setTimeout(120_000);

// apps/user-service — where prisma.config.ts + prisma/ live.
const PKG_ROOT = join(__dirname, '..', '..');
const PRISMA_BIN = join(PKG_ROOT, 'node_modules', '.bin', 'prisma');

// Real-Postgres integration test: the repository is all SQL, so mocking the
// client would test nothing. Same image the chart deploys, and we apply the
// actual migration files via `migrate deploy` — exactly what runs in prod.
describe('ProfileRepository (postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let repository: ProfileRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    execFileSync(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: PKG_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'inherit',
    });
    // PrismaService builds its pg adapter from the DB_* env, like the deployment.
    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getPort());
    process.env.DB_USER = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.DB_NAME = container.getDatabase();
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new ProfileRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE user_profiles');
  });

  it('ensure creates a profile with empty preferences', async () => {
    const profile = await repository.ensure('auth0|1', 'a@example.com', 'Alice');

    expect(profile).toMatchObject({
      sub: 'auth0|1',
      email: 'a@example.com',
      displayName: 'Alice',
      preferences: {},
    });
    expect(profile.createdAt).toBeInstanceOf(Date);
  });

  it('ensure is idempotent and never overwrites a chosen display name', async () => {
    await repository.ensure('auth0|1', 'a@example.com', 'Alice');
    await repository.update('auth0|1', { displayName: 'Ace' });

    // Re-login with a changed IdP email and a different IdP-derived name.
    const again = await repository.ensure('auth0|1', 'new@example.com', 'Alice From IdP');

    expect(again.email).toBe('new@example.com');
    expect(again.displayName).toBe('Ace');

    const rows = await prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM user_profiles`;
    expect(rows[0].n).toBe(1);
  });

  it('get returns null for an unknown sub', async () => {
    await expect(repository.get('auth0|missing')).resolves.toBeNull();
  });

  it('update patches only the provided fields', async () => {
    await repository.ensure('auth0|1', 'a@example.com', 'Alice');

    const withPrefs = await repository.update('auth0|1', {
      preferences: { theme: 'dark', lang: 'de' },
    });
    expect(withPrefs?.displayName).toBe('Alice');
    expect(withPrefs?.preferences).toEqual({ theme: 'dark', lang: 'de' });

    const renamed = await repository.update('auth0|1', { displayName: 'Ace' });
    expect(renamed?.displayName).toBe('Ace');
    expect(renamed?.preferences).toEqual({ theme: 'dark', lang: 'de' });
  });

  it('update returns null for an unknown sub', async () => {
    await expect(repository.update('auth0|missing', { displayName: 'X' })).resolves.toBeNull();
  });

  it('update bumps updated_at', async () => {
    const created = await repository.ensure('auth0|1', 'a@example.com', 'Alice');
    const updated = await repository.update('auth0|1', { displayName: 'Ace' });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect(updated!.createdAt).toEqual(created.createdAt);
  });
});

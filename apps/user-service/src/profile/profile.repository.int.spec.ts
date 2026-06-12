import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ProfileRepository } from './profile.repository';

jest.setTimeout(120_000);

// Real-Postgres integration test: the repository is all SQL, so mocking the
// pool would test nothing. Same image the chart deploys.
describe('ProfileRepository (postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let repository: ProfileRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    repository = new ProfileRepository(pool);
    await repository.onModuleInit();
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE user_profiles');
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

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM user_profiles');
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

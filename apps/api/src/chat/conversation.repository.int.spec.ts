import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationRepository } from './conversation.repository';

jest.setTimeout(120_000);

// apps/api — where prisma.config.ts + prisma/ live.
const PKG_ROOT = join(__dirname, '..', '..');
const PRISMA_BIN = join(PKG_ROOT, 'node_modules', '.bin', 'prisma');

describe('ConversationRepository (postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let prisma: PrismaService;
  let repository: ConversationRepository;

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
    repository = new ConversationRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE conversations CASCADE');
  });

  it('creates a conversation owned by the user', async () => {
    const conversation = await repository.createConversation('auth0|alice');
    expect(conversation.userSub).toBe('auth0|alice');
    expect(conversation.title).toBeNull();
    await expect(repository.getConversation(conversation.id, 'auth0|alice')).resolves.toMatchObject(
      { id: conversation.id },
    );
  });

  it('hides foreign conversations — ownership is part of the lookup', async () => {
    const conversation = await repository.createConversation('auth0|alice');
    await expect(repository.getConversation(conversation.id, 'auth0|mallory')).resolves.toBeNull();
  });

  it('appends messages with a strictly increasing per-conversation seq', async () => {
    const conversation = await repository.createConversation('auth0|alice');
    const first = await repository.appendMessage(conversation.id, 'user', 'hi');
    const second = await repository.appendMessage(conversation.id, 'assistant', 'hello!');
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    const other = await repository.createConversation('auth0|alice');
    const fresh = await repository.appendMessage(other.id, 'user', 'new convo');
    expect(fresh.seq).toBe(1); // seq is per conversation, not global
  });

  it('survives concurrent appends without seq collisions', async () => {
    const conversation = await repository.createConversation('auth0|alice');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repository.appendMessage(conversation.id, 'user', `m${i}`),
      ),
    );
    const seqs = results.map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('lists only active messages in seq order', async () => {
    const conversation = await repository.createConversation('auth0|alice');
    await repository.appendMessage(conversation.id, 'user', 'one');
    const second = await repository.appendMessage(conversation.id, 'assistant', 'two');
    await repository.appendMessage(conversation.id, 'user', 'three');
    await pool.query('UPDATE messages SET active = false WHERE id = $1', [second.id]);

    const chain = await repository.listActiveMessages(conversation.id);
    expect(chain.map((m) => m.content)).toEqual(['one', 'three']);
  });

  it('records the parent seam without using it yet', async () => {
    const conversation = await repository.createConversation('auth0|alice');
    const userMsg = await repository.appendMessage(conversation.id, 'user', 'q');
    const reply = await repository.appendMessage(conversation.id, 'assistant', 'a', userMsg.id);
    expect(reply.parentMessageId).toBe(userMsg.id);
  });

  it('bumps the conversation updated_at on append', async () => {
    const conversation = await repository.createConversation('auth0|alice');
    await repository.appendMessage(conversation.id, 'user', 'hi');
    const after = await repository.getConversation(conversation.id, 'auth0|alice');
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(conversation.updatedAt.getTime());
  });
});

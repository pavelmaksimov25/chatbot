import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { LoggerModule } from 'nestjs-pino';
import type { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { PG_POOL } from '../db/db.module';
import { AuditModule } from './audit.module';
import { AuditService, OUTPUT_AUDIT_QUEUE } from './audit.service';

jest.setTimeout(180_000);

async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('condition not reached in time');
}

/** The async tail against real Redis + Postgres: enqueue → worker → flag. */
describe('Output audit (integration)', () => {
  let redis: StartedRedisContainer;
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let queue: Queue;
  let enqueue: (job: { conversationId: string; messageId: string; userSub: string }) => void;

  beforeAll(async () => {
    [redis, postgres] = await Promise.all([
      new RedisContainer('valkey/valkey:8-alpine').start(),
      new PostgreSqlContainer('postgres:17-alpine').start(),
    ]);
    process.env.VALKEY_HOST = redis.getHost();
    process.env.VALKEY_PORT = String(redis.getPort());
    delete process.env.VALKEY_PASSWORD;

    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await pool.query(`
      CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_sub text NOT NULL);
      CREATE TABLE messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
        content text NOT NULL,
        flagged boolean NOT NULL DEFAULT false,
        flag_reason text
      );
    `);

    // BullModule.forRootAsync reads env at bootstrap — set above, safe here.
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), AuditModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const service = moduleRef.get(AuditService);
    enqueue = (job) => service.enqueueOutputAudit(job);
    queue = moduleRef.get<Queue>(getQueueToken(OUTPUT_AUDIT_QUEUE));
  });

  afterAll(async () => {
    // app.close() ends the pool too — DbModule's lifecycle owns the override.
    await app?.close();
    await Promise.allSettled([redis?.stop(), postgres?.stop()]);
  });

  async function insertMessage(content: string): Promise<{ conversationId: string; id: string }> {
    const conv = await pool.query<{ id: string }>(
      "INSERT INTO conversations (user_sub) VALUES ('auth0|alice') RETURNING id",
    );
    const msg = await pool.query<{ id: string }>(
      'INSERT INTO messages (conversation_id, content) VALUES ($1, $2) RETURNING id',
      [conv.rows[0].id, content],
    );
    return { conversationId: conv.rows[0].id, id: msg.rows[0].id };
  }

  it('flags a response containing a secret shortly after the turn', async () => {
    const message = await insertMessage('sure, the key is AKIAIOSFODNN7EXAMPLE — happy to help!');
    enqueue({
      conversationId: message.conversationId,
      messageId: message.id,
      userSub: 'auth0|alice',
    });

    await until(async () => {
      const { rows } = await pool.query<{ flagged: boolean }>(
        'SELECT flagged FROM messages WHERE id = $1',
        [message.id],
      );
      return rows[0].flagged;
    });

    const { rows } = await pool.query<{ flag_reason: string }>(
      'SELECT flag_reason FROM messages WHERE id = $1',
      [message.id],
    );
    expect(rows[0].flag_reason).toBe('aws-access-key-id');
  });

  it('leaves a clean response unflagged after processing', async () => {
    const message = await insertMessage('Valkey is a Redis-compatible store.');
    enqueue({
      conversationId: message.conversationId,
      messageId: message.id,
      userSub: 'auth0|alice',
    });

    // Wait until the queue is drained, then assert nothing was flagged.
    await until(async () => {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      return counts.waiting === 0 && counts.active === 0 && counts.delayed === 0;
    });
    const { rows } = await pool.query<{ flagged: boolean }>(
      'SELECT flagged FROM messages WHERE id = $1',
      [message.id],
    );
    expect(rows[0].flagged).toBe(false);
  });

  it('configures retry-with-backoff on every job', async () => {
    const message = await insertMessage('checking job options');
    enqueue({
      conversationId: message.conversationId,
      messageId: message.id,
      userSub: 'auth0|alice',
    });

    await until(async () => (await queue.getJobs(['completed'])).length >= 1);
    const jobs = await queue.getJobs(['completed', 'waiting', 'active']);
    const job = jobs.find((j) => j.data.messageId === message.id) ?? jobs[0];
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('treats an already-deleted message as done, not as a failure', async () => {
    const message = await insertMessage('soon gone');
    await pool.query('DELETE FROM messages WHERE id = $1', [message.id]);
    enqueue({
      conversationId: message.conversationId,
      messageId: message.id,
      userSub: 'auth0|alice',
    });

    await until(async () => {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      return counts.waiting === 0 && counts.active === 0 && counts.delayed === 0;
    });
    const counts = await queue.getJobCounts('failed');
    expect(counts.failed).toBe(0);
  });
});

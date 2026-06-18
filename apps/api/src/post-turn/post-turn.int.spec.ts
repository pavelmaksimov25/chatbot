import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { LoggerModule } from 'nestjs-pino';
import { BullModule } from '@nestjs/bullmq';
import { PG_POOL } from '../db/db.module';
import { LLM_ADAPTER } from '../llm/llm-adapter';
import { FakeLlmAdapter } from '../llm/fake.adapter';
import { ConversationRepository } from '../chat/conversation.repository';
import { PostTurnProcessor } from './post-turn.processor';
import { PostTurnService, POST_TURN_QUEUE } from './post-turn.service';

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

/** Chips + titles against real Redis + Postgres; the model is replayed. */
describe('Post-turn jobs (integration)', () => {
  let redis: StartedRedisContainer;
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let llm: FakeLlmAdapter;
  let service: PostTurnService;
  let repository: ConversationRepository;

  beforeAll(async () => {
    [redis, postgres] = await Promise.all([
      new RedisContainer('valkey/valkey:8-alpine').start(),
      new PostgreSqlContainer('postgres:17-alpine').start(),
    ]);
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    llm = new FakeLlmAdapter([]);

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        BullModule.forRoot({
          connection: {
            host: redis.getHost(),
            port: redis.getPort(),
            maxRetriesPerRequest: null,
          },
        }),
        BullModule.registerQueue({ name: POST_TURN_QUEUE }),
      ],
      providers: [
        PostTurnService,
        PostTurnProcessor,
        ConversationRepository,
        { provide: PG_POOL, useValue: pool },
        { provide: LLM_ADAPTER, useValue: llm },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    repository = moduleRef.get(ConversationRepository);
    await repository.onModuleInit();
    service = moduleRef.get(PostTurnService);
  });

  afterAll(async () => {
    await app?.close();
    // No DbModule here — the pool is a plain useValue, so end it ourselves
    // BEFORE the container dies under it.
    await pool?.end();
    await Promise.allSettled([redis?.stop(), postgres?.stop()]);
  });

  async function seedTurn(): Promise<{ conversationId: string; assistantId: string }> {
    const conversation = await repository.createConversation('auth0|alice');
    await repository.appendMessage(conversation.id, 'user', 'how do I cache in valkey?');
    const assistant = await repository.appendMessage(
      conversation.id,
      'assistant',
      'Use SETEX for TTL-based caching…',
    );
    return { conversationId: conversation.id, assistantId: assistant.id };
  }

  it('writes 2-3 chips tied to the answer and titles the conversation', async () => {
    const { conversationId, assistantId } = await seedTurn();
    // Both jobs share one replay queue — order does not matter because each
    // output parses for exactly one consumer (array vs words).
    llm.replay(['["What about eviction?", "How to monitor hit rate?"]\nValkey Caching Basics']);
    // The fake yields the same text for both jobs; chips parse the array,
    // the title sanitizer strips it down to usable words.
    service.enqueuePostTurn({
      conversationId,
      assistantMessageId: assistantId,
      userSub: 'auth0|alice',
    });

    await until(async () => {
      const s = await repository.getSuggestions(conversationId, 'auth0|alice');
      return (s?.suggestions.length ?? 0) > 0;
    });
    const suggestions = await repository.getSuggestions(conversationId, 'auth0|alice');
    expect(suggestions!.forMessageId).toBe(assistantId);
    expect(suggestions!.suggestions).toEqual(['What about eviction?', 'How to monitor hit rate?']);

    await until(async () => {
      const conversation = await repository.getConversation(conversationId, 'auth0|alice');
      return conversation!.title !== null;
    });
    const conversation = await repository.getConversation(conversationId, 'auth0|alice');
    expect(conversation!.title!.length).toBeGreaterThan(0);
    expect(conversation!.title!.length).toBeLessThanOrEqual(60);
  });

  it('never overwrites an existing title', async () => {
    const { conversationId, assistantId } = await seedTurn();
    await pool.query("UPDATE conversations SET title = 'My Chosen Name' WHERE id = $1", [
      conversationId,
    ]);
    llm.replay(['["Next step?"]\nGenerated Title']);
    service.enqueuePostTurn({
      conversationId,
      assistantMessageId: assistantId,
      userSub: 'auth0|alice',
    });

    await until(async () => {
      const s = await repository.getSuggestions(conversationId, 'auth0|alice');
      return (s?.suggestions.length ?? 0) > 0;
    });
    const conversation = await repository.getConversation(conversationId, 'auth0|alice');
    expect(conversation!.title).toBe('My Chosen Name');
  });

  it('newer chips replace older ones (latest answer wins)', async () => {
    const { conversationId, assistantId } = await seedTurn();
    llm.replay(['["Old chip?"]']);
    service.enqueuePostTurn({
      conversationId,
      assistantMessageId: assistantId,
      userSub: 'auth0|alice',
    });
    await until(async () => {
      const s = await repository.getSuggestions(conversationId, 'auth0|alice');
      return (s?.suggestions.length ?? 0) > 0;
    });

    const second = await repository.appendMessage(conversationId, 'assistant', 'next answer');
    llm.replay(['["New chip A?", "New chip B?"]']);
    service.enqueuePostTurn({
      conversationId,
      assistantMessageId: second.id,
      userSub: 'auth0|alice',
    });

    await until(async () => {
      const s = await repository.getSuggestions(conversationId, 'auth0|alice');
      return s?.forMessageId === second.id;
    });
    const suggestions = await repository.getSuggestions(conversationId, 'auth0|alice');
    expect(suggestions!.suggestions).toEqual(['New chip A?', 'New chip B?']);
  });
});

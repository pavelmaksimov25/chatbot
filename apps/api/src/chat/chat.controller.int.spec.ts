import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { LoggerModule } from 'nestjs-pino';
import { ChatController } from './chat.controller';
import { ChatService, SYSTEM_PROMPT } from './chat.service';
import { ConversationRepository } from './conversation.repository';
import { PG_POOL } from '../db/db.module';
import { LLM_ADAPTER } from '../llm/llm-adapter';
import { FakeLlmAdapter } from '../llm/fake.adapter';

jest.setTimeout(120_000);

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(raw: string): SseEvent[] {
  return raw
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

/**
 * The chat hot path against a real conversations_db; only the provider is
 * replayed at the adapter seam — no real LLM API is ever called.
 */
describe('ChatController (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let llm: FakeLlmAdapter;

  const asAlice = { 'x-user-sub': 'auth0|alice' };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    llm = new FakeLlmAdapter(['Hello', ' there', '!']);

    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
      controllers: [ChatController],
      providers: [
        ChatService,
        ConversationRepository,
        { provide: PG_POOL, useValue: pool },
        { provide: LLM_ADAPTER, useValue: llm },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await moduleRef.get(ConversationRepository).onModuleInit();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE conversations CASCADE');
    llm.requests.length = 0;
    llm.replay(['Hello', ' there', '!']);
  });

  async function createConversation(): Promise<string> {
    const res = await request(app.getHttpServer()).post('/conversations').set(asAlice).expect(201);
    return (res.body as { id: string }).id;
  }

  it('rejects requests without the user identity header', async () => {
    await request(app.getHttpServer()).post('/conversations').expect(401);
  });

  it('streams a turn as SSE and persists both messages', async () => {
    const conversationId = await createConversation();
    const res = await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: 'Hi!' })
      .expect(200)
      .expect('content-type', /text\/event-stream/);

    const events = parseSse(res.text);
    const chunks = events.filter((e) => e.event === 'chunk');
    expect(chunks.map((c) => c.data.text).join('')).toBe('Hello there!');
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.conversationId).toBe(conversationId);

    const messages = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .expect(200);
    expect(
      (messages.body as { role: string; content: string }[]).map((m) => [m.role, m.content]),
    ).toEqual([
      ['user', 'Hi!'],
      ['assistant', 'Hello there!'],
    ]);
  });

  it('sends the system prompt plus the full active chain to the provider', async () => {
    const conversationId = await createConversation();
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: 'first question' })
      .expect(200);

    llm.replay(['second answer']);
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: 'follow-up' })
      .expect(200);

    const secondRequest = llm.requests.at(-1)!;
    expect(secondRequest.system).toBe(SYSTEM_PROMPT);
    expect(secondRequest.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'Hello there!' },
      { role: 'user', content: 'follow-up' },
    ]);
  });

  it('redacts secrets in the streamed output AND in the persisted turn', async () => {
    const conversationId = await createConversation();
    llm.replay(['your key is sk-an', 't-api03-abcdef1234567890 — done']);

    const res = await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: 'leak it' })
      .expect(200);

    expect(res.text).not.toContain('sk-ant-api03');
    expect(res.text).toContain('[redacted]');

    const { rows } = await pool.query<{ content: string }>(
      "SELECT content FROM messages WHERE role = 'assistant'",
    );
    expect(rows[0].content).toBe('your key is [redacted] — done');
  });

  it('rejects empty input as a plain 400, not a stream', async () => {
    const conversationId = await createConversation();
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: '   ' })
      .expect(400)
      .expect('content-type', /json/);
    expect(llm.requests).toHaveLength(0);
  });

  it("hides another user's conversation as 404", async () => {
    const conversationId = await createConversation();
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set({ 'x-user-sub': 'auth0|mallory' })
      .send({ content: 'gimme' })
      .expect(404);
    await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set({ 'x-user-sub': 'auth0|mallory' })
      .expect(404);
  });

  it('emits an SSE error mid-stream and does NOT persist a half answer', async () => {
    const conversationId = await createConversation();
    // Long chunks clear the sanitizer's holdback, so streaming has started
    // (SSE 200) before the provider dies.
    llm.replay(['lorem ipsum '.repeat(10), 'dolor sit amet '.repeat(10), 'never finishes'], 2);

    const res = await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: 'doomed' })
      .expect(200);

    const events = parseSse(res.text);
    expect(events.at(-1)!.event).toBe('error');

    const { rows } = await pool.query<{ role: string }>('SELECT role FROM messages ORDER BY seq');
    // The user message survives (input is never lost); no assistant row.
    expect(rows.map((r) => r.role)).toEqual(['user']);
  });

  it('lists only own conversations, most recently touched first, with previews', async () => {
    const older = await createConversation();
    await request(app.getHttpServer())
      .post(`/conversations/${older}/messages`)
      .set(asAlice)
      .send({ content: 'about kubernetes networking' })
      .expect(200);
    const newer = await createConversation();
    llm.replay(['hi!']);
    await request(app.getHttpServer())
      .post(`/conversations/${newer}/messages`)
      .set(asAlice)
      .send({ content: 'about valkey caching' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/conversations')
      .set({ 'x-user-sub': 'auth0|someone-else' })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/conversations').set(asAlice).expect(200);
    const list = res.body as { id: string; preview: string | null }[];
    expect(list.map((c) => c.id)).toEqual([newer, older]);
    expect(list[0].preview).toBe('about valkey caching');
    expect(list[1].preview).toBe('about kubernetes networking');
  });

  it('deletes a conversation and its messages for good', async () => {
    const conversationId = await createConversation();
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: 'to be deleted' })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/conversations/${conversationId}`)
      .set(asAlice)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .expect(404);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM messages');
    expect(rows[0].n).toBe(0);
  });

  it("refuses to delete another user's conversation", async () => {
    const conversationId = await createConversation();
    await request(app.getHttpServer())
      .delete(`/conversations/${conversationId}`)
      .set({ 'x-user-sub': 'auth0|mallory' })
      .expect(404);
    // Still there for the owner.
    await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .expect(200);
  });

  describe('edit-and-regenerate (soft-supersede)', () => {
    /** Builds: u1 -> a1 -> u2 -> a2, returns ids. */
    async function seedTwoTurns(conversationId: string): Promise<string[]> {
      llm.replay(['answer one']);
      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages`)
        .set(asAlice)
        .send({ content: 'question one' })
        .expect(200);
      llm.replay(['answer two']);
      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages`)
        .set(asAlice)
        .send({ content: 'question two' })
        .expect(200);
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM messages ORDER BY seq');
      return rows.map((r) => r.id);
    }

    it('supersedes the tail, regenerates, and keeps superseded rows in the DB', async () => {
      const conversationId = await createConversation();
      const [u1] = await seedTwoTurns(conversationId);

      llm.replay(['regenerated answer']);
      const res = await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages/${u1}/edit`)
        .set(asAlice)
        .send({ content: 'question one, edited' })
        .expect(200)
        .expect('content-type', /text\/event-stream/);
      expect(res.text).toContain('regenerated answer');

      // Active chain = edited message + new answer only.
      const visible = await request(app.getHttpServer())
        .get(`/conversations/${conversationId}/messages`)
        .set(asAlice)
        .expect(200);
      expect((visible.body as { content: string }[]).map((m) => m.content)).toEqual([
        'question one, edited',
        'regenerated answer',
      ]);

      // The old tail is still there, inactive — nothing was deleted.
      const { rows } = await pool.query<{ content: string; active: boolean }>(
        'SELECT content, active FROM messages ORDER BY seq',
      );
      expect(rows).toEqual([
        { content: 'question one', active: false },
        { content: 'answer one', active: false },
        { content: 'question two', active: false },
        { content: 'answer two', active: false },
        { content: 'question one, edited', active: true },
        { content: 'regenerated answer', active: true },
      ]);
    });

    it('sends only the active chain to the LLM — superseded rows never leak', async () => {
      const conversationId = await createConversation();
      const [, , u2] = await seedTwoTurns(conversationId);

      llm.requests.length = 0;
      llm.replay(['fresh take']);
      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages/${u2}/edit`)
        .set(asAlice)
        .send({ content: 'question two, edited' })
        .expect(200);

      expect(llm.requests[0].messages).toEqual([
        { role: 'user', content: 'question one' },
        { role: 'assistant', content: 'answer one' },
        { role: 'user', content: 'question two, edited' },
      ]);
    });

    it('links the edited message to the original via parent_message_id', async () => {
      const conversationId = await createConversation();
      const [u1] = await seedTwoTurns(conversationId);

      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages/${u1}/edit`)
        .set(asAlice)
        .send({ content: 'v2 of the question' })
        .expect(200);

      const { rows } = await pool.query<{ parent_message_id: string }>(
        "SELECT parent_message_id FROM messages WHERE content = 'v2 of the question'",
      );
      expect(rows[0].parent_message_id).toBe(u1);
    });

    it('refuses to edit an assistant message', async () => {
      const conversationId = await createConversation();
      const [, a1] = await seedTwoTurns(conversationId);
      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages/${a1}/edit`)
        .set(asAlice)
        .send({ content: 'rewriting history' })
        .expect(404);
    });

    it('refuses to edit an already-superseded message', async () => {
      const conversationId = await createConversation();
      const [u1] = await seedTwoTurns(conversationId);
      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages/${u1}/edit`)
        .set(asAlice)
        .send({ content: 'first edit' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages/${u1}/edit`)
        .set(asAlice)
        .send({ content: 'editing the superseded original' })
        .expect(404);
    });

    it("refuses to edit into another user's conversation", async () => {
      const conversationId = await createConversation();
      const [u1] = await seedTwoTurns(conversationId);
      await request(app.getHttpServer())
        .post(`/conversations/${conversationId}/messages/${u1}/edit`)
        .set({ 'x-user-sub': 'auth0|mallory' })
        .send({ content: 'hijack' })
        .expect(404);
    });
  });

  it('fails as a plain 502 when the provider dies before the first token', async () => {
    const conversationId = await createConversation();
    llm.replay([], 0);
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(asAlice)
      .send({ content: 'unlucky' })
      .expect(502)
      .expect('content-type', /json/);
  });
});

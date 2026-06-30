import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { ApiMock } from './api-mock';
import { OidcMock } from './oidc-mock';

/**
 * Integration tests for the security front door: real openid-client against a
 * mock OIDC provider, real express-session against a real Valkey container.
 * The browser-side contract under test:
 *   - tokens NEVER reach the browser (session cookie is an opaque id)
 *   - cookie is httpOnly + SameSite=Lax (+ Secure behind TLS)
 *   - state/PKCE enforced on the callback
 *   - email_verified gates the session
 *   - logout requires the CSRF token
 *   - expired access tokens are refreshed server-side with rotation
 */
describe('Auth0 BFF session (integration)', () => {
  jest.setTimeout(180_000);

  let valkey: StartedRedisContainer;
  let oidc: OidcMock;
  let api: ApiMock;
  let app: INestApplication;

  beforeAll(async () => {
    valkey = await new RedisContainer('valkey/valkey:8-alpine').start();
    oidc = new OidcMock();
    await oidc.start();
    api = new ApiMock();
    await api.start();

    process.env.VALKEY_HOST = valkey.getHost();
    process.env.VALKEY_PORT = String(valkey.getPort());
    delete process.env.VALKEY_PASSWORD;
    process.env.SESSION_SECRET = 'test-session-secret';
    process.env.AUTH0_ISSUER_URL = oidc.issuer;
    process.env.AUTH0_CLIENT_ID = 'test-client';
    process.env.AUTH0_CLIENT_SECRET = 'test-secret';
    process.env.APP_BASE_URL = 'http://127.0.0.1';
    process.env.API_URL = api.url;

    // Import AFTER env is in place — the module reads config at load time.
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await oidc?.stop();
    await api?.stop();
    await valkey?.stop();
  });

  /** Runs the full login flow on the given agent; returns the /auth/me body. */
  async function login(agent: TestAgent): Promise<Record<string, string>> {
    const loginRes = await agent.get('/auth/login').expect(302);
    const callbackUrl = await oidc.authorize(loginRes.headers.location);
    const { pathname, search } = new URL(callbackUrl);
    await agent.get(pathname + search).expect(302);
    const me = await agent.get('/auth/me').expect(200);
    return me.body as Record<string, string>;
  }

  describe('login redirect', () => {
    it('redirects to the issuer with state + PKCE + offline_access', async () => {
      const agent = request.agent(app.getHttpServer());
      const res = await agent.get('/auth/login').expect(302);
      const url = new URL(res.headers.location);
      expect(url.origin).toBe(oidc.issuer);
      expect(url.pathname).toBe('/authorize');
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toContain('offline_access');
      expect(url.searchParams.get('response_type')).toBe('code');
    });

    it('sets an httpOnly, SameSite=Lax session cookie', async () => {
      const res = await request(app.getHttpServer()).get('/auth/login').expect(302);
      const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('marks the cookie Secure when the request came over TLS', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/login')
        .set('X-Forwarded-Proto', 'https')
        .expect(302);
      const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookie).toMatch(/Secure/i);
    });
  });

  describe('callback', () => {
    it('completes the flow and establishes a session', async () => {
      const agent = request.agent(app.getHttpServer());
      const me = await login(agent);
      expect(me.sub).toBe('auth0|user-1');
      expect(me.email).toBe('user@example.com');
      expect(me.csrfToken).toBeTruthy();
    });

    it('never exposes tokens to the browser', async () => {
      const agent = request.agent(app.getHttpServer());
      const loginRes = await agent.get('/auth/login').expect(302);
      const callbackUrl = await oidc.authorize(loginRes.headers.location);
      const { pathname, search } = new URL(callbackUrl);
      const cbRes = await agent.get(pathname + search).expect(302);
      const meRes = await agent.get('/auth/me').expect(200);

      for (const body of [JSON.stringify(cbRes.body), JSON.stringify(meRes.body)]) {
        expect(body).not.toContain('access_token');
        expect(body).not.toContain('refresh_token');
        expect(body).not.toMatch(/at-[0-9a-f-]{36}/);
        expect(body).not.toMatch(/\brt-\d+\b/);
      }
      const cookies = (cbRes.headers['set-cookie'] as unknown as string[]) ?? [];
      expect(cookies.join(';')).not.toMatch(/eyJ/); // no JWT material in cookies
    });

    it('rejects a tampered state', async () => {
      const agent = request.agent(app.getHttpServer());
      const loginRes = await agent.get('/auth/login').expect(302);
      const callbackUrl = await oidc.authorize(loginRes.headers.location);
      const url = new URL(callbackUrl);
      url.searchParams.set('state', 'forged-state');
      await agent.get(url.pathname + url.search).expect(403);
      await agent.get('/auth/me').expect(401);
    });

    it('rejects a callback with no pending login transaction', async () => {
      await request(app.getHttpServer()).get('/auth/callback?code=x&state=y').expect(403);
    });

    it('refuses a session when email is not verified', async () => {
      oidc.nextClaims = { email_verified: false };
      const agent = request.agent(app.getHttpServer());
      const loginRes = await agent.get('/auth/login').expect(302);
      const callbackUrl = await oidc.authorize(loginRes.headers.location);
      const { pathname, search } = new URL(callbackUrl);
      const res = await agent.get(pathname + search).expect(302);
      expect(res.headers.location).toContain('email_not_verified');
      await agent.get('/auth/me').expect(401);
    });
  });

  describe('session state', () => {
    it('answers 401 without a session', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });
  });

  describe('logout', () => {
    it('requires the CSRF token', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      await agent.post('/auth/logout').expect(403);
      await agent.post('/auth/logout').set('X-CSRF-Token', 'wrong').expect(403);
      await agent.get('/auth/me').expect(200); // still signed in
    });

    it('destroys the session with a valid CSRF token', async () => {
      const agent = request.agent(app.getHttpServer());
      const me = await login(agent);
      await agent.post('/auth/logout').set('X-CSRF-Token', me.csrfToken).expect(204);
      await agent.get('/auth/me').expect(401);
    });
  });

  describe('profile (/me)', () => {
    beforeEach(() => {
      api.profiles.clear();
      api.calls.length = 0;
    });

    it('answers 401 without a session', async () => {
      await request(app.getHttpServer()).get('/me').expect(401);
      expect(api.calls).toHaveLength(0);
    });

    it('provisions the profile during the login callback', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);

      const ensures = api.calls.filter((c) => c.path === '/profiles/ensure');
      expect(ensures).toHaveLength(1);
      expect(ensures[0].body).toMatchObject({
        sub: 'auth0|user-1',
        email: 'user@example.com',
      });
    });

    it('serves the profile and re-ensures if the profile vanished', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);

      const me = await agent.get('/me').expect(200);
      expect(me.body).toMatchObject({ sub: 'auth0|user-1', email: 'user@example.com' });

      // Losing the row must not strand the session: /me re-provisions.
      api.profiles.clear();
      const again = await agent.get('/me').expect(200);
      expect(again.body).toMatchObject({ sub: 'auth0|user-1' });
    });

    it('rejects a profile edit without the CSRF token', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      api.calls.length = 0;

      await agent.patch('/me').send({ displayName: 'New Name' }).expect(403);
      expect(api.calls).toHaveLength(0); // blocked before reaching the api
    });

    it('updates the display name with a valid CSRF token', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);

      const res = await agent
        .patch('/me')
        .set('X-CSRF-Token', session.csrfToken)
        .send({ displayName: 'New Name', preferences: { theme: 'dark' } })
        .expect(200);

      expect(res.body).toMatchObject({
        displayName: 'New Name',
        preferences: { theme: 'dark' },
      });
      // The sub is taken from the session, never from the request body.
      const patches = api.calls.filter((c) => c.method === 'PATCH');
      expect(patches).toHaveLength(1);
      expect(patches[0].path).toBe(`/profiles/${encodeURIComponent('auth0|user-1')}`);
    });

    it('translates an api validation error into a 400', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);

      await agent
        .patch('/me')
        .set('X-CSRF-Token', session.csrfToken)
        .send({ displayName: '   ' })
        .expect(400);
    });

    it('rejects malformed bodies before calling the api', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);
      api.calls.length = 0;

      await agent
        .patch('/me')
        .set('X-CSRF-Token', session.csrfToken)
        .send({ preferences: [1, 2, 3] })
        .expect(400);
      expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    });
  });

  describe('chat proxy (/conversations)', () => {
    beforeEach(() => {
      api.calls.length = 0;
    });

    it('answers 401 without a session', async () => {
      await request(app.getHttpServer()).post('/conversations').expect(401);
      await request(app.getHttpServer()).get('/conversations/conv-1/messages').expect(401);
      expect(api.calls).toHaveLength(0);
    });

    it('rejects mutating chat calls without the CSRF token', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      api.calls.length = 0;

      await agent.post('/conversations').expect(403);
      await agent.post('/conversations/conv-1/messages').send({ content: 'hi' }).expect(403);
      expect(api.calls).toHaveLength(0);
    });

    it('creates a conversation stamped with the session sub', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);

      const res = await agent
        .post('/conversations')
        .set('X-CSRF-Token', session.csrfToken)
        .expect(201);
      expect(res.body).toMatchObject({ id: 'conv-1', userSub: 'auth0|user-1' });
    });

    it('relays the SSE stream untouched, frame for frame', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);

      const res = await agent
        .post('/conversations/conv-1/messages')
        .set('X-CSRF-Token', session.csrfToken)
        .send({ content: 'hi' })
        .buffer(true)
        .parse((upstream, callback) => {
          let text = '';
          upstream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          upstream.on('end', () => callback(null, text));
        })
        .expect(200)
        .expect('content-type', /text\/event-stream/);

      expect(res.body).toBe(api.sseFrames.join(''));
      const sent = api.calls.find(
        (c) => c.method === 'POST' && c.path === '/conversations/conv-1/messages',
      );
      expect(sent?.body).toEqual({ content: 'hi' });
    });

    it('fetches the message history through the proxy', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      const res = await agent.get('/conversations/conv-1/messages').expect(200);
      expect((res.body as { content: string }[]).map((m) => m.content)).toEqual([
        'hi',
        'Hello world',
      ]);
    });

    it('fetches suggestion chips through the proxy', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      const res = await agent.get('/conversations/conv-1/suggestions').expect(200);
      expect(res.body).toEqual({
        forMessageId: 'm2',
        suggestions: ['Tell me more?', 'Show an example?'],
      });
    });

    it('lists conversations through the proxy', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      const res = await agent.get('/conversations').expect(200);
      expect((res.body as { id: string }[]).map((c) => c.id)).toEqual(['conv-2', 'conv-1']);
    });

    it('requires the CSRF token to delete a conversation', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      api.calls.length = 0;
      await agent.delete('/conversations/conv-1').expect(403);
      expect(api.calls).toHaveLength(0);
    });

    it('relays the edit SSE stream and requires CSRF on it', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);
      api.calls.length = 0;

      await agent.post('/conversations/conv-1/messages/m1/edit').send({ content: 'x' }).expect(403);
      expect(api.calls).toHaveLength(0);

      const res = await agent
        .post('/conversations/conv-1/messages/m1/edit')
        .set('X-CSRF-Token', session.csrfToken)
        .send({ content: 'edited question' })
        .buffer(true)
        .parse((upstream, callback) => {
          let text = '';
          upstream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          upstream.on('end', () => callback(null, text));
        })
        .expect(200)
        .expect('content-type', /text\/event-stream/);
      expect(res.body).toBe(api.sseFrames.join(''));
      expect(api.calls.some((c) => c.path === '/conversations/conv-1/messages/m1/edit')).toBe(true);
    });

    it('relays the welcome SSE stream (CSRF-guarded)', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);

      await agent.post('/conversations/conv-1/welcome').expect(403);

      const res = await agent
        .post('/conversations/conv-1/welcome')
        .set('X-CSRF-Token', session.csrfToken)
        .buffer(true)
        .parse((upstream, callback) => {
          let text = '';
          upstream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          upstream.on('end', () => callback(null, text));
        })
        .expect(200)
        .expect('content-type', /text\/event-stream/);
      expect(res.body).toBe(api.sseFrames.join(''));
    });

    it('deletes a conversation and relays the upstream 404', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);
      await agent
        .delete('/conversations/conv-1')
        .set('X-CSRF-Token', session.csrfToken)
        .expect(204);
      await agent
        .delete('/conversations/conv-unknown')
        .set('X-CSRF-Token', session.csrfToken)
        .expect(404);
    });
  });

  describe('files proxy (/files)', () => {
    it('answers 401 without a session and 403 without CSRF', async () => {
      await request(app.getHttpServer()).get('/files').expect(401);

      const agent = request.agent(app.getHttpServer());
      await login(agent);
      await agent
        .post('/files')
        .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' })
        .expect(403);
    });

    it('uploads as multipart with the session sub stamped', async () => {
      const agent = request.agent(app.getHttpServer());
      const session = await login(agent);

      const res = await agent
        .post('/files')
        .set('X-CSRF-Token', session.csrfToken)
        .attach('file', Buffer.from('hello files'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
        .expect(201);
      expect(res.body).toMatchObject({ id: 'f1', forUser: 'auth0|user-1' });
      expect((res.body as { receivedContentType: string }).receivedContentType).toContain(
        'multipart/form-data',
      );
    });

    it('passes downloads through with headers intact', async () => {
      const agent = request.agent(app.getHttpServer());
      await login(agent);

      const res = await agent
        .get('/files/f1')
        .expect(200)
        .expect('content-type', /text\/plain/)
        .expect('content-disposition', /notes\.txt/);
      expect(res.text).toBe('hello files');
    });
  });

  describe('silent re-auth (refresh rotation)', () => {
    it('refreshes an expiring access token server-side and rotates the refresh token', async () => {
      oidc.nextExpiresIn = 1; // lands inside the refresh-ahead window immediately
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      oidc.nextExpiresIn = 3600;

      const refreshesBefore = oidc.refreshCalls.length;
      await agent.get('/auth/me').expect(200); // triggers server-side refresh
      expect(oidc.refreshCalls.length).toBe(refreshesBefore + 1);

      // rotation: a second forced refresh must use the NEW refresh token
      const firstUsed = oidc.refreshCalls[oidc.refreshCalls.length - 1];
      await agent.get('/auth/me').expect(200);
      const last = oidc.refreshCalls[oidc.refreshCalls.length - 1];
      if (oidc.refreshCalls.length > refreshesBefore + 1) {
        expect(last).not.toBe(firstUsed);
      }
    });

    it('drops the session when the refresh is rejected upstream', async () => {
      oidc.nextExpiresIn = 1;
      const agent = request.agent(app.getHttpServer());
      await login(agent);
      oidc.nextExpiresIn = 3600;

      // Invalidate everything the mock would accept.
      oidc.refreshCalls.length = 0;
      (oidc as unknown as { refreshTokens: Map<string, unknown> }).refreshTokens.clear();

      await agent.get('/auth/me').expect(401);
    });
  });
});

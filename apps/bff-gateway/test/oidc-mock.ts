import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

/**
 * Minimal OIDC provider for integration tests: discovery, JWKS, authorize
 * (302 with code), token endpoint with authorization_code + refresh_token
 * grants (rotating refresh tokens). Fully deterministic and controllable —
 * set `nextClaims` / `nextExpiresIn` before driving a flow. Uses only
 * node:crypto (RS256 via RSASSA-PKCS1-v1_5) so jest needs no ESM gymnastics.
 */
export class OidcMock {
  issuer = '';
  /** Claims merged into the next issued ID token. */
  nextClaims: Record<string, unknown> = {};
  /** expires_in for the next issued access tokens (seconds). */
  nextExpiresIn = 3600;
  /** Every refresh_token grant call lands here. */
  refreshCalls: string[] = [];

  private server!: Server;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly publicJwk: JsonWebKey = {
    ...this.keys.publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    use: 'sig',
    kid: 'test',
  };
  private codes = new Map<string, { nonce?: string; claims: Record<string, unknown> }>();
  private refreshTokens = new Map<string, { claims: Record<string, unknown> }>();
  private refreshCounter = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req.url ?? '/', req, res);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('mock server failed to bind');
    }
    this.issuer = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  /** Follows the /authorize redirect and returns the app callback URL. */
  async authorize(authUrl: string): Promise<string> {
    const res = await fetch(authUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status !== 302 || !location) {
      throw new Error(`authorize did not redirect: ${res.status}`);
    }
    return location;
  }

  private async handle(url: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname, searchParams } = new URL(url, this.issuer);

    if (pathname === '/.well-known/openid-configuration') {
      return this.json(res, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }

    if (pathname === '/jwks') {
      return this.json(res, { keys: [this.publicJwk] });
    }

    if (pathname === '/authorize') {
      const code = randomUUID();
      this.codes.set(code, {
        nonce: searchParams.get('nonce') ?? undefined,
        claims: { ...this.nextClaims },
      });
      this.nextClaims = {};
      const redirect = new URL(searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', searchParams.get('state') ?? '');
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }

    if (pathname === '/token') {
      const body = new URLSearchParams(await this.readBody(req));
      const grantType = body.get('grant_type');

      if (grantType === 'authorization_code') {
        const entry = this.codes.get(body.get('code') ?? '');
        if (!entry) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        this.codes.delete(body.get('code') ?? '');
        return this.tokenResponse(res, entry.claims, body.get('client_id'), entry.nonce, true);
      }

      if (grantType === 'refresh_token') {
        const token = body.get('refresh_token') ?? '';
        this.refreshCalls.push(token);
        const entry = this.refreshTokens.get(token);
        if (!entry) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        this.refreshTokens.delete(token); // rotation: old token is single-use
        return this.tokenResponse(res, entry.claims, body.get('client_id'), undefined, false);
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    }

    res.writeHead(404);
    res.end();
  }

  private tokenResponse(
    res: ServerResponse,
    claims: Record<string, unknown>,
    clientId: string | null,
    nonce: string | undefined,
    includeIdToken: boolean,
  ): void {
    const refreshToken = `rt-${++this.refreshCounter}`;
    this.refreshTokens.set(refreshToken, { claims });

    const response: Record<string, unknown> = {
      access_token: `at-${randomUUID()}`,
      token_type: 'Bearer',
      expires_in: this.nextExpiresIn,
      refresh_token: refreshToken,
    };

    if (includeIdToken) {
      const now = Math.floor(Date.now() / 1000);
      response.id_token = this.signJwt({
        iss: this.issuer,
        aud: clientId ?? '',
        iat: now,
        exp: now + 300,
        sub: 'auth0|user-1',
        email: 'user@example.com',
        email_verified: true,
        name: 'Test User',
        ...claims,
        ...(nonce ? { nonce } : {}),
      });
    }

    this.json(res, response);
  }

  private signJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test' })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${body}`)
      .sign(this.keys.privateKey)
      .toString('base64url');
    return `${header}.${body}.${signature}`;
  }

  private json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk: Buffer) => (data += chunk.toString()));
      req.on('end', () => resolve(data));
    });
  }
}

import 'express-session';

// All Auth0 tokens live HERE, server-side in the Valkey-backed session —
// the browser only ever holds the opaque session cookie (BFF pattern).
declare module 'express-session' {
  interface SessionData {
    pendingAuth?: { state: string; nonce: string; codeVerifier: string };
    user?: { sub: string; email: string; name?: string };
    tokens?: { accessToken: string; refreshToken?: string; expiresAt: number };
    csrfToken?: string;
  }
}

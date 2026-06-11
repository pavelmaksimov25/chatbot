export interface AuthConfig {
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  appBaseUrl: string;
  sessionSecret?: string;
}

export function authConfig(): AuthConfig {
  const domain = process.env.AUTH0_DOMAIN;
  return {
    // AUTH0_ISSUER_URL (full URL) wins — used by tests and non-Auth0 issuers.
    issuerUrl: process.env.AUTH0_ISSUER_URL ?? (domain ? `https://${domain}` : undefined),
    clientId: process.env.AUTH0_CLIENT_ID || undefined,
    clientSecret: process.env.AUTH0_CLIENT_SECRET || undefined,
    appBaseUrl: process.env.APP_BASE_URL ?? 'https://localhost:8443',
    sessionSecret: process.env.SESSION_SECRET || undefined,
  };
}

export function isAuthConfigured(cfg: AuthConfig = authConfig()): boolean {
  return Boolean(cfg.issuerUrl && cfg.clientId && cfg.clientSecret);
}

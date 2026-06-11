import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as client from 'openid-client';
import { authConfig, isAuthConfigured } from './auth.config';

export interface LoginTransaction {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export type Tokens = client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;

@Injectable()
export class OidcService {
  private configuration?: client.Configuration;

  redirectUri(): string {
    return new URL('/auth/callback', authConfig().appBaseUrl).toString();
  }

  async startLogin(): Promise<LoginTransaction> {
    const configuration = await this.getConfiguration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri(),
      // offline_access → refresh token (rotation enabled in the tenant)
      scope: 'openid profile email offline_access',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async exchangeCode(
    currentUrl: URL,
    tx: { state: string; nonce: string; codeVerifier: string },
  ): Promise<Tokens> {
    const configuration = await this.getConfiguration();
    return client.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: tx.codeVerifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    const configuration = await this.getConfiguration();
    return client.refreshTokenGrant(configuration, refreshToken);
  }

  private async getConfiguration(): Promise<client.Configuration> {
    if (this.configuration) {
      return this.configuration;
    }
    const cfg = authConfig();
    if (!isAuthConfigured(cfg) || !cfg.issuerUrl || !cfg.clientId || !cfg.clientSecret) {
      throw new ServiceUnavailableException(
        'authentication is not configured — provision the Auth0 tenant and re-run the secrets bootstrap',
      );
    }
    const issuer = new URL(cfg.issuerUrl);
    // http issuers exist only in tests (mock provider); Auth0 is always https.
    const options =
      issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined;
    this.configuration = await client.discovery(
      issuer,
      cfg.clientId,
      cfg.clientSecret,
      undefined,
      options,
    );
    return this.configuration;
  }
}

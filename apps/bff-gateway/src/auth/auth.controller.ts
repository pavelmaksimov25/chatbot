import { randomBytes } from 'node:crypto';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import './session.types';
import { OidcService } from './oidc.service';
import { authConfig } from './auth.config';
import { ProfileApiClient } from '../profile/api-client.service';

// Refresh ahead of expiry so a request never rides on a token that dies mid-flight.
const REFRESH_AHEAD_MS = 60_000;

export interface MeResponse {
  sub: string;
  email: string;
  name?: string;
  csrfToken: string;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly oidc: OidcService,
    private readonly profiles: ProfileApiClient,
  ) {}

  @Get('login')
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    const tx = await this.oidc.startLogin();
    req.session.pendingAuth = {
      state: tx.state,
      nonce: tx.nonce,
      codeVerifier: tx.codeVerifier,
    };
    await this.save(req);
    res.redirect(tx.url);
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const pending = req.session.pendingAuth;
    if (!pending) {
      throw new ForbiddenException('no login transaction in progress');
    }
    delete req.session.pendingAuth; // single-use: a replayed callback must fail

    let tokens;
    try {
      tokens = await this.oidc.exchangeCode(
        new URL(req.originalUrl, authConfig().appBaseUrl),
        pending,
      );
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'code exchange failed',
      );
      throw new ForbiddenException('login could not be completed');
    }

    const claims = tokens.claims();
    if (!claims) {
      throw new ForbiddenException('missing ID token');
    }
    if (claims.email_verified !== true) {
      // Auth0 sent the user back unverified — no session until the email gate passes.
      res.redirect('/?error=email_not_verified');
      return;
    }

    await this.regenerate(req); // session fixation defense: fresh id on privilege change
    req.session.user = {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : '',
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
    req.session.tokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
    };
    req.session.csrfToken = randomBytes(32).toString('hex');
    await this.save(req);

    // First login provisions the app profile. Best-effort: a dead api must
    // not block the login — /me re-ensures on its 404 fallback.
    const { sub, email, name } = req.session.user;
    try {
      await this.profiles.ensureProfile(sub, email, name ?? email);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'profile provisioning failed — deferred to first /me',
      );
    }

    res.redirect('/');
  }

  @Get('me')
  async me(@Req() req: Request): Promise<MeResponse> {
    if (!req.session.user || !req.session.csrfToken) {
      throw new UnauthorizedException();
    }
    await this.ensureFreshTokens(req);
    const { sub, email, name } = req.session.user;
    return { sub, email, name, csrfToken: req.session.csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    // CSRF is enforced by the global guard before we get here.
    await this.destroy(req);
    res.clearCookie('sid');
    res.status(204).end();
  }

  /** Silent re-auth: rotate the refresh token server-side when the access token nears expiry. */
  private async ensureFreshTokens(req: Request): Promise<void> {
    const tokens = req.session.tokens;
    if (!tokens?.refreshToken || Date.now() < tokens.expiresAt - REFRESH_AHEAD_MS) {
      return;
    }
    try {
      const refreshed = await this.oidc.refresh(tokens.refreshToken);
      req.session.tokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
        expiresAt: Date.now() + (refreshed.expires_in ?? 0) * 1000,
      };
      await this.save(req);
    } catch {
      // Refresh token revoked/expired upstream → the session is dead.
      await this.destroy(req);
      throw new UnauthorizedException('session expired');
    }
  }

  private save(req: Request): Promise<void> {
    return new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
  }

  private regenerate(req: Request): Promise<void> {
    return new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
  }

  private destroy(req: Request): Promise<void> {
    return new Promise((resolve, reject) =>
      req.session.destroy((err) => (err ? reject(err) : resolve())),
    );
  }
}

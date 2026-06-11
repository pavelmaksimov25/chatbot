import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import type { RequestHandler } from 'express';
import { authConfig } from './auth.config';

/**
 * Owns the Valkey connection backing the session store (node-redis — the
 * client connect-redis is built for) so it participates in the application
 * lifecycle: connected before traffic, closed on shutdown. Without the
 * close, the open socket keeps the process (and jest) alive.
 */
@Injectable()
export class SessionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SessionService.name);

  private readonly client = createClient({
    socket: {
      host: process.env.VALKEY_HOST ?? 'localhost',
      port: Number(process.env.VALKEY_PORT ?? 6379),
    },
    password: process.env.VALKEY_PASSWORD || undefined,
  });

  // Without a configured secret, sessions can't survive restarts — fall back
  // to an ephemeral one so the service still boots (auth answers 503 until
  // the tenant credentials are bootstrapped anyway).
  readonly middleware: RequestHandler = session({
    store: new RedisStore({ client: this.client, prefix: 'sess:' }),
    name: 'sid',
    secret: authConfig().sessionSecret ?? randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: 'auto', // Secure whenever the request came over TLS (trust proxy)
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });

  async onModuleInit(): Promise<void> {
    // node-redis turns unhandled 'error' events into process crashes.
    this.client.on('error', (err: Error) => {
      this.logger.warn(`session store connection error: ${err.message}`);
    });
    await this.client.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

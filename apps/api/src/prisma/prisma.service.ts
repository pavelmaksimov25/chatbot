import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The Prisma client, wired to the existing `pg` driver via the Postgres driver
 * adapter (Prisma 7 is Rust-engine-free). Connection params come from the same
 * DB_* env the old pg Pool used — no DATABASE_URL composition needed at runtime;
 * that env is only for the Prisma CLI (migrate). The module owns connect/close
 * so consumers never touch the connection lifecycle.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        max: 5,
        connectionTimeoutMillis: 2000,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

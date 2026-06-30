import path from 'node:path';
import { defineConfig } from 'prisma/config';

// The Migrate connection URL (Prisma 7 keeps it out of schema.prisma). Used
// ONLY by the Prisma CLI (migrate/diff/deploy); the running service connects
// through @prisma/adapter-pg built from the DB_* env (see PrismaService).
//
// Precedence: an explicit DATABASE_URL (tests, ad-hoc) wins; otherwise compose
// it from the same DB_* env the deployment already sets — so the migration
// initContainer needs no separate secret and the password is URL-encoded here
// rather than in fragile shell. Falls back to a placeholder so generate/
// validate work with no env at all (CI, Docker build).
function databaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const { DB_HOST, DB_PORT = '5432', DB_USER, DB_PASSWORD = '', DB_NAME } = process.env;
  if (DB_HOST && DB_USER && DB_NAME) {
    const auth = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}`;
    return `postgresql://${auth}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  }
  return 'postgresql://localhost:5432/placeholder';
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: databaseUrl(),
  },
});

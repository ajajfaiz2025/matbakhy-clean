import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Prisma 7 requires an explicit driver adapter instead of reading
// datasource.url implicitly. The adapter only holds the connection
// string lazily — it does not connect until the first query — so this
// is safe to construct even when DATABASE_URL isn't set yet (e.g. at
// build time before a real Postgres instance exists).
function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
  return new PrismaClient({ adapter });
}

// Standard Next.js singleton: dev hot-reload would otherwise open a new
// Prisma connection pool on every module reload.
export const db = globalThis.__prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = db;
}

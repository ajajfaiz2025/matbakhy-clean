import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 moved the connection URL out of schema.prisma and into this
// config file (the datasource `url` field is no longer supported there).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});

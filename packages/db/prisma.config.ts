import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Load the repo-root .env (Prisma 7 does not load .env files itself).
loadDotenv({ path: path.resolve(__dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // The CLI (migrate, studio, seed) always uses the direct, owner connection.
  datasource: { url: env('DIRECT_URL') },
});

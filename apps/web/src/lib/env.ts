import { z } from 'zod';
import { parseEnv } from '@wacrm/shared';

const schema = z.object({ NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000') });

// Next inlines NEXT_PUBLIC_* only when referenced statically.
export const env = parseEnv(schema, { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL });

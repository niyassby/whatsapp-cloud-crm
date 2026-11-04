import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEnv } from './env';

describe('parseEnv', () => {
  const schema = z.object({ PORT: z.coerce.number().int().positive() });

  it('parses valid input', () => {
    expect(parseEnv(schema, { PORT: '4000' })).toEqual({ PORT: 4000 });
  });

  it('throws a readable error on invalid input', () => {
    expect(() => parseEnv(schema, {})).toThrow(/PORT/);
  });
});

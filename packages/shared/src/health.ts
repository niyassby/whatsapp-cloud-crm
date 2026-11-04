import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export function buildHealth(service: string): HealthResponse {
  return { status: 'ok', service, time: new Date().toISOString() };
}

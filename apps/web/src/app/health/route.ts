import { buildHealth } from '@wacrm/shared';

export function GET() {
  return Response.json(buildHealth('web'));
}

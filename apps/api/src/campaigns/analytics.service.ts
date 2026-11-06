import { Injectable } from '@nestjs/common';
import type { DashboardDto, VolumePoint } from '@wacrm/shared';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

const DAY_MS = 86_400_000;

const dayKey = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

const rate = (part: number, whole: number) => (whole ? part / whole : null);

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: TenantPrismaService) {}

  /**
   * Reviewed raw SQL: bound parameters, under the tenant's RLS context. Every query bounds
   * created_at, so Postgres only touches the partitions in range.
   */
  async dashboard(orgId: string, days: number): Promise<DashboardDto> {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);

    const result = await this.db.run(
      async (tx) => {
        const org = await tx.organization.findUniqueOrThrow({
          where: { id: orgId },
          select: { timezone: true },
        });
        const timezone = org.timezone;

        const volume = await tx.$queryRaw<{ day: string; direction: string; count: bigint }[]>`
          SELECT to_char(created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
                 direction::text AS direction,
                 COUNT(*)::bigint AS count
          FROM messages
          WHERE created_at >= ${from} AND direction IN ('inbound', 'outbound')
          GROUP BY 1, 2`;

        const statuses = await tx.$queryRaw<{ status: string; count: bigint }[]>`
          SELECT status::text AS status, COUNT(*)::bigint AS count
          FROM messages
          WHERE created_at >= ${from} AND direction = 'outbound'
          GROUP BY 1`;

        // A person's reply straight after a customer's message. Broadcasts have no sender, so
        // they do not count as answering anyone.
        const [response] = await tx.$queryRaw<{ median: number | null; replied: bigint }[]>`
          SELECT percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (created_at - previous_at))
                 )::float8 AS median,
                 COUNT(*)::bigint AS replied
          FROM (
            SELECT created_at, direction, sender_user_id,
                   LAG(direction) OVER w AS previous_direction,
                   LAG(created_at) OVER w AS previous_at
            FROM messages
            WHERE created_at >= ${from} AND direction <> 'internal'
            WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id)
          ) m
          WHERE direction = 'outbound'
            AND sender_user_id IS NOT NULL
            AND previous_direction = 'inbound'`;

        const activeConversations = await tx.conversation.count({ where: { status: 'open' } });
        return { timezone, volume, statuses, response, activeConversations };
      },
      { timeout: 20_000 },
    );

    // Every day appears, so a quiet day shows as zero rather than vanishing from the chart.
    const byDay = new Map<string, VolumePoint>();
    for (let i = days; i >= 0; i--) {
      const day = dayKey(new Date(to.getTime() - i * DAY_MS), result.timezone);
      byDay.set(day, { day, inbound: 0, outbound: 0 });
    }
    for (const row of result.volume) {
      const point = byDay.get(row.day);
      if (point) point[row.direction as 'inbound' | 'outbound'] = Number(row.count);
    }
    const volume = [...byDay.values()];

    const count = (...names: string[]) =>
      result.statuses
        .filter((s) => names.includes(s.status))
        .reduce((sum, s) => sum + Number(s.count), 0);
    const delivered = count('delivered', 'read');
    const read = count('read');
    const failed = count('failed');
    const attempted = count('sent') + delivered + failed;

    return {
      days,
      timezone: result.timezone,
      volume,
      totals: {
        inbound: volume.reduce((sum, p) => sum + p.inbound, 0),
        outbound: volume.reduce((sum, p) => sum + p.outbound, 0),
      },
      outbound: {
        attempted,
        delivered,
        read,
        failed,
        deliveryRate: rate(delivered, attempted),
        readRate: rate(read, attempted),
        failureRate: rate(failed, attempted),
      },
      responseTime: {
        medianSeconds: result.response?.median ?? null,
        replied: Number(result.response?.replied ?? 0n),
      },
      activeConversations: result.activeConversations,
    };
  }
}

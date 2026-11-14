import { Injectable } from '@nestjs/common';
import { conversationsReport } from '@wacrm/db';
import { type DashboardDto, lastDays } from '@wacrm/shared';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

const rate = (part: number, whole: number) => (whole ? part / whole : null);

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: TenantPrismaService) {}

  /**
   * The dashboard reads the aggregates the worker keeps (Phase 4.3), never the messages table,
   * so it stays fast for any workspace. Figures can be up to five minutes behind.
   */
  async dashboard(orgId: string, days: number): Promise<DashboardDto> {
    const result = await this.db.run(
      async (tx) => {
        const { timezone } = await tx.organization.findUniqueOrThrow({
          where: { id: orgId },
          select: { timezone: true },
        });
        // `days` back from today, both ends included, as before.
        const range = lastDays(days + 1, timezone);
        const report = await conversationsReport(tx, orgId, range);
        // Reviewed raw SQL: bound parameters, under the tenant's RLS context.
        const [statuses] = await tx.$queryRaw<
          {
            sent: bigint | null;
            delivered: bigint | null;
            read: bigint | null;
            failed: bigint | null;
          }[]
        >`
          SELECT sum(sent)::bigint AS sent, sum(delivered)::bigint AS delivered,
                 sum(read)::bigint AS read, sum(failed)::bigint AS failed
          FROM analytics_hourly
          WHERE org_id = ${orgId}::uuid
            AND hour >= ${`${range.from} 00:00:00`}::timestamp
            AND hour < (${range.to}::date + 1)::timestamp`;
        return { timezone, report, statuses };
      },
      { timeout: 20_000 },
    );

    const { report } = result;
    const volume = report.daily.map((d) => ({
      day: d.day,
      inbound: d.inbound,
      outbound: d.outbound,
    }));
    const sent = Number(result.statuses?.sent ?? 0n);
    const delivered = Number(result.statuses?.delivered ?? 0n);
    const read = Number(result.statuses?.read ?? 0n);
    const failed = Number(result.statuses?.failed ?? 0n);
    const attempted = sent + failed;

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
        medianSeconds: report.totals.medianResponseSeconds,
        replied: report.totals.responses,
      },
      activeConversations: report.totals.openNow,
    };
  }
}

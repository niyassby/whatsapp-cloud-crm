import { messageInclude, messageToDto, withTenant } from '@wacrm/db';
import type { MediaDownloadJob } from '@wacrm/shared';
import { mediaKey } from '@wacrm/shared/server';
import { RetryableJobError, type WorkerDeps } from '../deps';

/** Copy inbound media to object storage while Meta's short-lived URL still works. */
export async function downloadInboundMedia(
  deps: WorkerDeps,
  job: MediaDownloadJob,
  opts: { finalAttempt: boolean },
): Promise<void> {
  const { orgId, messageId } = job;
  const where = { id_createdAt: { id: messageId, createdAt: new Date(job.createdAt) } };

  async function finish(data: {
    mediaStatus: 'stored' | 'failed';
    mediaKey?: string;
    mediaSize?: number;
    mediaMime?: string;
  }) {
    const row = await withTenant(deps.db, { orgId }, (tx) =>
      tx.message.update({ where, data, include: messageInclude }),
    );
    deps.publisher.emit(orgId, 'message:updated', { message: messageToDto(row) });
  }

  const gateway = await deps.whatsapp.get({ orgId, phoneNumberId: job.phoneNumberId });
  const media = await gateway.downloadMedia(job.metaMediaId);
  if (media.error) {
    if (media.error.retryable && !opts.finalAttempt) {
      throw new RetryableJobError(media.error.message);
    }
    await finish({ mediaStatus: 'failed' });
    return;
  }

  const key = mediaKey(orgId, messageId);
  await deps.storage.put(key, media.data.bytes, media.data.mimeType);
  await finish({
    mediaStatus: 'stored',
    mediaKey: key,
    mediaSize: media.data.bytes.length,
    mediaMime: media.data.mimeType,
  });
}

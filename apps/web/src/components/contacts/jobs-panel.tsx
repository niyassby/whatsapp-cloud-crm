'use client';

import type { ContactJobDto } from '@wacrm/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { downloadJobFile, useContactJobs } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';

const number = (n: number) => n.toLocaleString();

function summary(job: ContactJobDto): string {
  if (job.status === 'failed') return job.error ?? 'This job failed';
  if (job.status === 'queued') return 'Waiting to start';
  if (job.kind === 'export') {
    return job.status === 'completed'
      ? `${number(job.processedRows)} contacts exported`
      : `${number(job.processedRows)} contacts so far`;
  }
  const parts = [`${number(job.createdCount)} new`, `${number(job.updatedCount)} updated`];
  if (job.errorCount) parts.push(`${number(job.errorCount)} with errors`);
  return job.status === 'completed'
    ? parts.join(', ')
    : `${number(job.processedRows)} rows read: ${parts.join(', ')}`;
}

const VARIANT = {
  queued: 'outline',
  processing: 'secondary',
  completed: 'default',
  failed: 'destructive',
} as const;

/** Imports and exports still running, and the most recent finished ones. */
export function JobsPanel() {
  const jobs = useContactJobs(true);
  const recent = jobs.data?.slice(0, 3) ?? [];
  if (recent.length === 0) return null;

  const download = async (id: string) => {
    try {
      await downloadJobFile(id);
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <ul className="grid gap-1 rounded-md border p-2" aria-label="Imports and exports">
      {recent.map((job) => (
        <li key={job.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={VARIANT[job.status]}>{job.status}</Badge>
          <span className="font-medium capitalize">{job.kind}</span>
          {job.filename && (
            <span className="max-w-48 truncate text-muted-foreground">{job.filename}</span>
          )}
          <span className="text-muted-foreground">{summary(job)}</span>
          {job.hasFile && (
            <Button
              size="sm"
              variant="link"
              className="ml-auto h-auto p-0"
              onClick={() => void download(job.id)}
            >
              {job.kind === 'export' ? 'Download' : 'Error report'}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

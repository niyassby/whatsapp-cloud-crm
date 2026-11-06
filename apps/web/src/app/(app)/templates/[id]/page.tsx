'use client';

import { Permission } from '@wacrm/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { TemplateForm } from '@/components/templates/template-form';
import { TemplatePreview } from '@/components/templates/template-preview';
import { rejectionText, TemplateStatusBadge } from '@/components/templates/template-status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/lib/queries';
import { useTemplate } from '@/lib/templates';

export default function TemplatePage() {
  const { id } = useParams<{ id: string }>();
  const canManage = useCan(Permission.TEMPLATES_MANAGE);
  const template = useTemplate(id);
  const t = template.data;

  return (
    <div className="mx-auto grid max-w-6xl gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon" variant="ghost" aria-label="Back to templates" asChild>
          <Link href="/templates">
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{t?.name ?? 'Template'}</h1>
        {t && <span className="text-muted-foreground">{t.language}</span>}
      </div>

      {template.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : template.isError || !t ? (
        <p className="text-sm text-muted-foreground">This template was not found.</p>
      ) : canManage ? (
        // Keyed by content, so a change from Meta (a webhook, or a sync) shows up in the form.
        <TemplateForm key={`${t.id}:${t.updatedAt}`} template={t} />
      ) : (
        <div className="grid max-w-md gap-3">
          <div className="flex items-center gap-2">
            <TemplateStatusBadge status={t.status} />
            <span className="text-sm text-muted-foreground">{t.category.toLowerCase()}</span>
          </div>
          {t.status === 'rejected' && (
            <p className="text-sm text-destructive">{rejectionText(t.rejectedReason)}</p>
          )}
          {t.definition && <TemplatePreview definition={t.definition} values={t.samples} />}
        </div>
      )}
    </div>
  );
}

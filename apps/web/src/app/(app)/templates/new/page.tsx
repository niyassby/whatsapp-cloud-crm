'use client';

import { Permission } from '@wacrm/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { TemplateForm } from '@/components/templates/template-form';
import { Button } from '@/components/ui/button';
import { useCan } from '@/lib/queries';

export default function NewTemplatePage() {
  const canManage = useCan(Permission.TEMPLATES_MANAGE);
  return (
    <div className="mx-auto grid max-w-6xl gap-4">
      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" aria-label="Back to templates" asChild>
          <Link href="/templates">
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">New template</h1>
      </div>
      {canManage ? (
        <TemplateForm />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can create templates.
        </p>
      )}
    </div>
  );
}

'use client';

import { Permission } from '@wacrm/shared';
import Link from 'next/link';
import { ContactsTable } from '@/components/contacts/contacts-table';
import { ImportDialog } from '@/components/contacts/import-dialog';
import { JobsPanel } from '@/components/contacts/jobs-panel';
import { NewContactDialog } from '@/components/contacts/new-contact-dialog';
import { Button } from '@/components/ui/button';
import { useCan } from '@/lib/queries';

export default function ContactsPage() {
  const canManage = useCan(Permission.CONTACTS_MANAGE);
  const canWrite = useCan(Permission.CONTACTS_WRITE);
  return (
    <div className="flex h-full min-h-[32rem] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" asChild>
            <Link href="/contacts/segments">Segments</Link>
          </Button>
          {canManage && <ImportDialog />}
          {canWrite && <NewContactDialog />}
        </div>
      </div>
      {canManage && <JobsPanel />}
      <ContactsTable />
    </div>
  );
}

'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { FlowDto } from '@wacrm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { FlowState } from '@/components/flows/flow-state';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { flowKeys, TRIGGER_LABELS, useFlows } from '@/lib/flows';
import { handleApiError } from '@/lib/forms';

function NewFlow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const flow = await api<FlowDto>('/flows', { method: 'POST', body: { name: name.trim() } });
      await queryClient.invalidateQueries({ queryKey: flowKeys.all });
      router.push(`/flows/${flow.id}`);
    } catch (err) {
      handleApiError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New flow</DialogTitle>
            <DialogDescription>
              A chatbot conversation: what starts it, the steps it takes, and where it hands over to
              your team.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Name"
            name="flow-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create flow
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function FlowsPage() {
  const flows = useFlows();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Flows</h1>
          <p className="text-sm text-muted-foreground">
            Chatbots that answer, ask, branch and hand over, started by a keyword, a new contact, a
            tag and more.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New flow</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your flows</CardTitle>
          <CardDescription>
            Only flows that are published and on start new runs. A running conversation keeps the
            version it started on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {flows.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : !flows.data?.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No flows yet. Create one to automate a conversation.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Starts on</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Running now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flows.data.map((flow) => (
                  <TableRow key={flow.id}>
                    <TableCell>
                      <Link href={`/flows/${flow.id}`} className="font-medium hover:underline">
                        {flow.name}
                      </Link>
                    </TableCell>
                    <TableCell>{TRIGGER_LABELS[flow.triggerType]}</TableCell>
                    <TableCell>
                      <FlowState flow={flow} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{flow.activeRuns}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <NewFlow open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

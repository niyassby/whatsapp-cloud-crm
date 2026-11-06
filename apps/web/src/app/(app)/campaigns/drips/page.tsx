'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { DripDto } from '@wacrm/shared';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { campaignKeys, useDrips } from '@/lib/campaigns';
import { useSegments, useTags } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { usePhoneNumbers } from '@/lib/queries';
import { useTemplates } from '@/lib/templates';

const NONE = '__none__';
const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
type Unit = keyof typeof UNIT_MINUTES;

interface StepDraft {
  key: number;
  amount: string;
  unit: Unit;
  templateId: string;
}

function delayText(minutes: number) {
  if (minutes === 0) return 'Straight away';
  if (minutes % 1440 === 0) return `After ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `After ${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `After ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function NewDrip({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const phones = usePhoneNumbers();
  const templates = useTemplates('approved', '');
  const tags = useTags();
  const [name, setName] = useState('');
  const [phoneId, setPhoneId] = useState('');
  const [exitOnReply, setExitOnReply] = useState(true);
  const [exitTagId, setExitTagId] = useState(NONE);
  const [steps, setSteps] = useState<StepDraft[]>([
    { key: 0, amount: '0', unit: 'minutes', templateId: '' },
  ]);
  const [busy, setBusy] = useState(false);

  const connected = (phones.data ?? []).filter((p) => p.status === 'connected');
  const phone = connected.find((p) => p.id === phoneId);
  const usable = (templates.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (t) => t.supported && phone && t.wabaAccountId === phone.wabaAccountId,
  );
  const setStep = (key: number, change: Partial<StepDraft>) =>
    setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...change } : s)));
  const ready = name.trim() && phoneId && steps.every((s) => s.templateId && s.amount !== '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/drips', {
        method: 'POST',
        body: {
          name: name.trim(),
          phoneId,
          exitOnReply,
          exitTagId: exitTagId === NONE ? null : exitTagId,
          steps: steps.map((s) => ({
            delayMinutes: Number(s.amount) * UNIT_MINUTES[s.unit],
            templateId: s.templateId,
          })),
        },
      });
      await queryClient.invalidateQueries({ queryKey: campaignKeys.drips });
      onClose();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New drip sequence</DialogTitle>
            <DialogDescription>
              Templates sent in order, each after a wait. Each step is charged like any template.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Name"
            name="drip-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="drip-phone">WhatsApp number</Label>
            <Select
              value={phoneId}
              onValueChange={(v) => {
                setPhoneId(v);
                setSteps((all) => all.map((s) => ({ ...s, templateId: '' })));
              }}
            >
              <SelectTrigger id="drip-phone" className="w-full">
                <SelectValue placeholder="Choose a number" />
              </SelectTrigger>
              <SelectContent>
                {connected.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.displayPhoneNumber ?? p.phoneNumberId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {steps.map((step, index) => (
            <fieldset key={step.key} className="flex flex-col gap-2 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Step {index + 1}</legend>
              <div className="flex items-end gap-2">
                <div className="w-24">
                  <FormField
                    label={index === 0 ? 'Wait after enrolling' : 'Wait'}
                    name={`step-${step.key}-amount`}
                    type="number"
                    min={0}
                    value={step.amount}
                    onChange={(e) => setStep(step.key, { amount: e.target.value })}
                  />
                </div>
                <Select
                  value={step.unit}
                  onValueChange={(v) => setStep(step.key, { unit: v as Unit })}
                >
                  <SelectTrigger aria-label="Wait unit" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">Minutes</SelectItem>
                    <SelectItem value="hours">Hours</SelectItem>
                    <SelectItem value="days">Days</SelectItem>
                  </SelectContent>
                </Select>
                {steps.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setSteps((all) => all.filter((s) => s.key !== step.key))}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <Select
                value={step.templateId}
                onValueChange={(v) => setStep(step.key, { templateId: v })}
                disabled={!phoneId}
              >
                <SelectTrigger aria-label={`Template for step ${index + 1}`} className="w-full">
                  <SelectValue
                    placeholder={phoneId ? 'Choose a template' : 'Choose a number first'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {usable.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={steps.length >= 20}
            onClick={() =>
              setSteps((all) => [
                ...all,
                {
                  key: Math.max(...all.map((s) => s.key)) + 1,
                  amount: '1',
                  unit: 'days',
                  templateId: '',
                },
              ])
            }
          >
            Add step
          </Button>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={exitOnReply}
              onChange={(e) => setExitOnReply(e.target.checked)}
            />
            Stop when the contact replies
          </label>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="drip-exit-tag">Stop when the contact has this tag</Label>
            <Select value={exitTagId} onValueChange={setExitTagId}>
              <SelectTrigger id="drip-exit-tag" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No tag</SelectItem>
                {(tags.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Anyone who opts out always leaves the sequence.
            </p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !ready}>
              Create sequence
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Enroll({ drip, onClose }: { drip: DripDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const segments = useSegments();
  const [segmentId, setSegmentId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!drip) return;
    setBusy(true);
    try {
      const res = await api<{ enrolled: number }>(`/drips/${drip.id}/enroll`, {
        method: 'POST',
        body: { segmentId },
      });
      toast.success(`${res.enrolled.toLocaleString()} enrolled`);
      await queryClient.invalidateQueries({ queryKey: campaignKeys.drips });
      onClose();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(drip)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enroll contacts</DialogTitle>
          <DialogDescription>
            Everyone in the segment starts at step 1. People already enrolled are left where they
            are.
          </DialogDescription>
        </DialogHeader>
        <Select value={segmentId} onValueChange={setSegmentId}>
          <SelectTrigger aria-label="Segment" className="w-full">
            <SelectValue placeholder="Choose a segment" />
          </SelectTrigger>
          <SelectContent>
            {(segments.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button disabled={busy || !segmentId} onClick={() => void submit()}>
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DripsPage() {
  const queryClient = useQueryClient();
  const drips = useDrips();
  const [creating, setCreating] = useState(false);
  const [enrolling, setEnrolling] = useState<DripDto | null>(null);

  const setStatus = async (drip: DripDto, status: 'active' | 'paused') => {
    try {
      await api(`/drips/${drip.id}/status`, { method: 'POST', body: { status } });
      await queryClient.invalidateQueries({ queryKey: campaignKeys.drips });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link href="/campaigns" className="text-sm text-muted-foreground hover:underline">
              Campaigns
            </Link>
            <h1 className="text-xl font-semibold">Drip sequences</h1>
          </div>
          <Button onClick={() => setCreating(true)}>New sequence</Button>
        </div>

        {drips.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : !drips.data?.length ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No sequences yet.
          </p>
        ) : (
          drips.data.map((drip) => (
            <Card key={drip.id}>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <CardTitle className="flex items-center gap-2">
                    {drip.name}
                    <Badge variant={drip.status === 'active' ? 'default' : 'outline'}>
                      {drip.status === 'active'
                        ? 'Active'
                        : drip.status === 'paused'
                          ? 'Paused'
                          : 'Draft'}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {drip.enrollments.active.toLocaleString()} in progress,{' '}
                    {drip.enrollments.completed.toLocaleString()} completed,{' '}
                    {drip.enrollments.exited.toLocaleString()} left early
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEnrolling(drip)}>
                    Enroll
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void setStatus(drip, drip.status === 'active' ? 'paused' : 'active')
                    }
                  >
                    {drip.status === 'active' ? 'Pause' : 'Activate'}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-1 text-sm">
                  {drip.steps.map((s) => (
                    <li key={s.id} className="flex justify-between gap-4">
                      <span>
                        {s.position + 1}. {s.templateName}
                      </span>
                      <span className="text-muted-foreground">{delayText(s.delayMinutes)}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ))
        )}
      </div>
      {/* Keyed so the form starts empty each time. */}
      {creating && <NewDrip open onClose={() => setCreating(false)} />}
      <Enroll drip={enrolling} onClose={() => setEnrolling(null)} />
    </div>
  );
}

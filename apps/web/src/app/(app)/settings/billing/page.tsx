'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type BillingInterval,
  type BillingSummaryDto,
  formatMoney,
  type InvoiceDto,
  Permission,
  PLAN_FEATURE_LABELS,
  PLAN_LIMIT_LABELS,
  PLAN_LIMITS,
  type PlanDto,
} from '@wacrm/shared';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, apiDownload } from '@/lib/api';
import {
  billingKeys,
  daysUntil,
  PROVIDER_LABELS,
  useBillingSummary,
  useInvoices,
  usePlans,
} from '@/lib/billing';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';

const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

const STATUS_TEXT: Record<BillingSummaryDto['status'], string> = {
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment failed',
  expired: 'Ended',
};

function Current({ summary, canManage }: { summary: BillingSummaryDto; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const openPayment = async () => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string | null }>('/billing/manage-payment', {
        method: 'POST',
      });
      if (url) window.location.assign(url);
      else toast.error('This payment provider has no page for that');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm('Cancel your subscription? You keep this plan until the period ends.')) {
      return;
    }
    setBusy(true);
    try {
      await api('/billing/cancel', { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            <span data-testid="current-plan">{summary.plan.name}</span>
            <Badge
              variant={summary.status === 'past_due' ? 'destructive' : 'secondary'}
              data-testid="plan-status"
            >
              {STATUS_TEXT[summary.status]}
            </Badge>
          </CardTitle>
          <CardDescription>
            {summary.status === 'trialing' && summary.trialEndsAt
              ? `${daysUntil(summary.trialEndsAt)} days left in your trial of ${summary.plan.name}.`
              : summary.cancelAtPeriodEnd
                ? `Cancelled. You keep this plan until ${dateText(summary.currentPeriodEnd)}.`
                : summary.currentPeriodEnd && summary.status !== 'expired'
                  ? `Renews on ${dateText(summary.currentPeriodEnd)}${
                      summary.provider ? ` through ${PROVIDER_LABELS[summary.provider]}` : ''
                    }.`
                  : summary.status === 'expired'
                    ? 'Your data is safe. Choose a plan below to add more or use paid features again.'
                    : null}
          </CardDescription>
        </div>
        {canManage && summary.hasPaidSubscription && (
          <div className="flex gap-2">
            {summary.canManagePayment && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void openPayment()}
              >
                Payment method
              </Button>
            )}
            {!summary.cancelAtPeriodEnd && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void cancel()}>
                Cancel plan
              </Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {PLAN_LIMITS.map((limit) => {
          const used = summary.usage[limit];
          const max = summary.plan[limit];
          const percent = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
          return (
            <div key={limit} className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-2 text-sm">
                <span className="capitalize text-muted-foreground">{PLAN_LIMIT_LABELS[limit]}</span>
                <span className="tabular-nums" data-testid={`usage-${limit}`}>
                  {used.toLocaleString()}
                  {max === null ? '' : ` of ${max.toLocaleString()}`}
                </span>
              </div>
              {max !== null && (
                <div
                  className="h-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${PLAN_LIMIT_LABELS[limit]} used`}
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function PlanPicker({ summary, canManage }: { summary: BillingSummaryDto; canManage: boolean }) {
  const queryClient = useQueryClient();
  const plans = usePlans();
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [busy, setBusy] = useState<string | null>(null);
  const paying = summary.hasPaidSubscription;
  const isCurrent = (plan: PlanDto) => paying && plan.code === summary.subscribedPlanCode;

  const choose = async (plan: PlanDto) => {
    setBusy(plan.code);
    try {
      const { url } = await api<{ url: string | null }>('/billing/checkout', {
        method: 'POST',
        body: { planCode: plan.code, interval },
      });
      if (url) {
        window.location.assign(url);
        return;
      }
      toast.success('Plan change requested. It applies once the payment provider confirms it.');
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
    } catch (err) {
      handleApiError(err);
    }
    setBusy(null);
  };

  if (plans.isPending) return <Skeleton className="h-64 w-full" />;
  const list = plans.data ?? [];
  const hasYearly = list.some((p) => p.prices.some((price) => price.interval === 'year'));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Plans</CardTitle>
        {hasYearly && (
          <div className="flex gap-1" role="group" aria-label="Billing period">
            {(['month', 'year'] as const).map((value) => (
              <Button
                key={value}
                variant={interval === value ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={interval === value}
                onClick={() => setInterval(value)}
              >
                {value === 'month' ? 'Monthly' : 'Yearly'}
              </Button>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-3">
        {list.map((plan) => {
          const price = plan.prices.find((p) => p.interval === interval);
          const buyable = Boolean(price?.providers.length);
          return (
            <div
              key={plan.code}
              data-testid={`plan-${plan.code}`}
              className="flex flex-col gap-3 rounded-lg border p-4"
            >
              <div>
                <p className="font-medium">{plan.name}</p>
                <p className="text-xl font-semibold tabular-nums">
                  {price ? `${formatMoney(price.amountMicros, price.currency)}` : 'Not available'}
                  {price && (
                    <span className="text-sm font-normal text-muted-foreground"> / {interval}</span>
                  )}
                </p>
                {price && <p className="text-xs text-muted-foreground">Taxes included</p>}
              </div>
              <ul className="flex flex-1 flex-col gap-1 text-sm text-muted-foreground">
                {PLAN_LIMITS.map((limit) => (
                  <li key={limit}>
                    {plan[limit] === null ? 'Unlimited' : plan[limit]?.toLocaleString()}{' '}
                    {PLAN_LIMIT_LABELS[limit]}
                  </li>
                ))}
                {plan.features.map((f) => (
                  <li key={f}>{PLAN_FEATURE_LABELS[f]}</li>
                ))}
              </ul>
              {canManage && (
                <Button
                  variant={isCurrent(plan) ? 'outline' : 'default'}
                  disabled={!buyable || isCurrent(plan) || busy !== null}
                  onClick={() => void choose(plan)}
                >
                  {isCurrent(plan)
                    ? 'Current plan'
                    : busy === plan.code
                      ? 'Opening…'
                      : paying
                        ? `Switch to ${plan.name}`
                        : `Choose ${plan.name}`}
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Profile({ summary, canManage }: { summary: BillingSummaryDto; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    billingName: summary.profile.billingName ?? '',
    billingEmail: summary.profile.billingEmail ?? '',
    billingAddress: summary.profile.billingAddress ?? '',
    billingCountry: summary.profile.billingCountry ?? '',
    taxId: summary.profile.taxId ?? '',
  });
  const [busy, setBusy] = useState(false);
  const field = (name: keyof typeof form, label: string, extra: object = {}) => (
    <FormField
      label={label}
      name={name}
      value={form[name]}
      disabled={!canManage}
      onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}
      {...extra}
    />
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const orNull = (v: string) => v.trim() || null;
      await api('/billing/profile', {
        method: 'PATCH',
        body: {
          billingName: orNull(form.billingName),
          billingEmail: orNull(form.billingEmail),
          billingAddress: orNull(form.billingAddress),
          billingCountry: orNull(form.billingCountry),
          taxId: orNull(form.taxId),
        },
      });
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success('Saved');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing details</CardTitle>
        <CardDescription>
          Printed on invoices. Your country decides the tax. Invoices already issued do not change.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="grid gap-4 sm:grid-cols-2">
          {field('billingName', 'Business name')}
          {field('billingEmail', 'Billing email', { type: 'email' })}
          {field('billingAddress', 'Address')}
          {field('billingCountry', 'Country (two letters)', { maxLength: 2, placeholder: 'IN' })}
          {field('taxId', 'Tax ID (optional)')}
          {canManage && (
            <div className="flex items-end justify-end">
              <Button type="submit" disabled={busy}>
                Save details
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function Invoices() {
  const invoices = useInvoices();
  const rows = invoices.data?.pages.flatMap((p) => p.items) ?? [];
  const download = (invoice: InvoiceDto) =>
    void apiDownload(`/billing/invoices/${invoice.id}/pdf`, `${invoice.number}.pdf`).catch(
      handleApiError,
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {invoices.isPending ? 'Loading…' : 'No invoices yet.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>For</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.number}</TableCell>
                  <TableCell>{dateText(i.issuedAt)}</TableCell>
                  <TableCell>{i.description}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(i.taxMicros, i.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(i.totalMicros, i.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => download(i)}>
                      Download PDF
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {invoices.hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            disabled={invoices.isFetchingNextPage}
            onClick={() => void invoices.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function PaymentNotice() {
  const payment = useSearchParams().get('payment');
  if (payment === 'done') {
    return (
      <Alert>
        <AlertTitle>Thanks, your payment is being confirmed</AlertTitle>
        <AlertDescription>This page updates by itself as soon as it is confirmed.</AlertDescription>
      </Alert>
    );
  }
  if (payment === 'cancelled') {
    return (
      <Alert>
        <AlertTitle>Payment cancelled</AlertTitle>
        <AlertDescription>Nothing was charged.</AlertDescription>
      </Alert>
    );
  }
  return null;
}

export default function BillingSettingsPage() {
  const canRead = useCan(Permission.BILLING_READ);
  const canManage = useCan(Permission.BILLING_MANAGE);
  const summary = useBillingSummary(canRead);

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">Only owners and admins can see billing.</p>;
  }
  if (summary.isError) {
    return <p className="text-sm text-destructive">Could not load billing.</p>;
  }
  if (!summary.data) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      <Suspense>
        <PaymentNotice />
      </Suspense>
      {summary.data.providers.length === 0 && canManage && (
        <Alert>
          <AlertTitle>Payments are not set up yet</AlertTitle>
          <AlertDescription>
            Plans cannot be bought until a payment provider is configured on this deployment.
          </AlertDescription>
        </Alert>
      )}
      <Current summary={summary.data} canManage={canManage} />
      <PlanPicker summary={summary.data} canManage={canManage} />
      <Profile summary={summary.data} canManage={canManage} />
      <Invoices />
    </div>
  );
}

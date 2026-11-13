'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type ClientDto,
  formatMoney,
  MAX_MARKUP_BPS,
  microsToDecimal,
  type PartnerDto,
  type PartnerPlanDto,
  PLAN_LIMIT_LABELS,
  PLAN_LIMITS,
  type PlanLimit,
} from '@wacrm/shared';
import { MoreHorizontal } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { FormField } from '@/components/form-field';
import {
  CreditDialog,
  ImpersonateDialog,
  type WorkspaceRef,
} from '@/components/reseller/workspace-dialogs';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import {
  partnerKeys,
  percentOf,
  useClients,
  usePartner,
  usePartnerLedger,
  usePartnerPlans,
  usePartnerStatements,
  usePartnerSummary,
} from '@/lib/reseller';
import { toast } from 'sonner';

const dateText = (iso: string) => new Date(iso).toLocaleDateString();
const limitText = (n: number | null) => (n === null ? 'No limit' : n.toLocaleString());
/** '' means "leave the plan's limit". */
const toLimit = (text: string): number | null => (text.trim() === '' ? null : Number(text));
const validLimit = (text: string) => text.trim() === '' || /^\d{1,9}$/.test(text.trim());

const LEDGER_LABELS: Record<string, string> = {
  usage: 'Usage',
  usage_refund: 'Refund',
  plan_fee: 'Plan',
  adjustment: 'Adjustment',
};

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

function Overview({ partner }: { partner: PartnerDto }) {
  const queryClient = useQueryClient();
  const summary = usePartnerSummary();
  const [percent, setPercent] = useState(String(partner.walletMarkupBps / 100));
  const [busy, setBusy] = useState(false);
  const bps = Math.round(Number(percent) * 100);
  const valid = percent.trim() !== '' && Number.isFinite(bps) && bps >= 0 && bps <= MAX_MARKUP_BPS;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/partner', { method: 'PATCH', body: { walletMarkupBps: bps } });
      await queryClient.invalidateQueries({ queryKey: partnerKeys.profile });
      toast.success('Markup saved. It applies to charges from now on.');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const money = (micros: number) => formatMoney(micros, partner.currency);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>This month so far</CardTitle>
          <CardDescription>
            You are invoiced at wholesale after the month ends, and collect from your clients
            yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          {summary.data ? (
            <>
              <Stat
                label="Due to the platform"
                value={money(summary.data.totalDueMicros)}
                hint="Client usage at wholesale. Plan fees are added when the month closes."
              />
              <Stat
                label="Charged to client wallets"
                value={money(summary.data.usageRetailMicros)}
                hint="Usage at your prices."
              />
              <Stat
                label="Your margin"
                value={money(summary.data.commissionMicros)}
                hint="What your markup earned."
              />
            </>
          ) : (
            <Skeleton className="h-16 w-full sm:col-span-3" />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Wallet markup</CardTitle>
          <CardDescription>
            Added to the price of every message and AI charge in your clients&apos; wallets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void save(e)} className="flex items-end gap-2">
            <FormField
              label="Markup (%)"
              name="markup"
              inputMode="decimal"
              value={percent}
              error={valid ? undefined : `Between 0 and ${MAX_MARKUP_BPS / 100}`}
              onChange={(e) => setPercent(e.target.value)}
            />
            <Button type="submit" disabled={busy || !valid || bps === partner.walletMarkupBps}>
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

interface ClientForm {
  name: string;
  ownerEmail: string;
  planCode: string;
  seats: string;
  numbers: string;
  contacts: string;
  clientPrice: string;
}

const emptyForm = (planCode = ''): ClientForm => ({
  name: '',
  ownerEmail: '',
  planCode,
  seats: '',
  numbers: '',
  contacts: '',
  clientPrice: '',
});

const formOf = (c: ClientDto): ClientForm => ({
  name: c.name,
  ownerEmail: c.ownerEmail ?? '',
  planCode: c.planCode ?? '',
  seats: c.partnerLimits.seats?.toString() ?? '',
  numbers: c.partnerLimits.numbers?.toString() ?? '',
  contacts: c.partnerLimits.contacts?.toString() ?? '',
  clientPrice: c.clientPriceMicros === null ? '' : microsToDecimal(c.clientPriceMicros),
});

/** Create a client, or edit one when `editing` is set. */
function ClientDialog({
  open,
  editing,
  plans,
  currency,
  onClose,
}: {
  open: boolean;
  editing: ClientDto | null;
  plans: PartnerPlanDto[];
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ClientForm>(emptyForm());
  const [seenKey, setSeenKey] = useState('');
  const [busy, setBusy] = useState(false);

  // Load the form when the dialog opens for a different client (or for a new one).
  const key = open ? (editing?.id ?? 'new') : '';
  if (key !== seenKey) {
    setSeenKey(key);
    if (open) setForm(editing ? formOf(editing) : emptyForm(plans[0]?.code));
  }

  const set = (patch: Partial<ClientForm>) => setForm((f) => ({ ...f, ...patch }));
  const plan = plans.find((p) => p.code === form.planCode);
  const limitsValid = PLAN_LIMITS.every((l) => validLimit(form[l]));
  const priceValid = form.clientPrice.trim() === '' || Number(form.clientPrice) >= 0;
  const ready =
    form.name.trim().length >= 2 &&
    Boolean(form.planCode) &&
    limitsValid &&
    priceValid &&
    (editing !== null || /.+@.+\..+/.test(form.ownerEmail));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const limits = {
      seats: toLimit(form.seats),
      numbers: toLimit(form.numbers),
      contacts: toLimit(form.contacts),
    };
    const clientPrice = form.clientPrice.trim() === '' ? null : form.clientPrice.trim();
    try {
      if (editing) {
        await api(`/partner/clients/${editing.id}`, {
          method: 'PATCH',
          body: {
            name: form.name.trim(),
            ...(form.planCode !== editing.planCode ? { planCode: form.planCode } : {}),
            limits,
            clientPrice,
          },
        });
      } else {
        await api('/partner/clients', {
          method: 'POST',
          body: {
            name: form.name.trim(),
            ownerEmail: form.ownerEmail.trim(),
            planCode: form.planCode,
            limits,
            clientPrice,
          },
        });
        toast.success(`Invitation sent to ${form.ownerEmail.trim()}`);
      }
      await queryClient.invalidateQueries({ queryKey: partnerKeys.all });
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
            <DialogTitle>{editing ? `Edit ${editing.name}` : 'New client workspace'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Changes apply straight away.'
                : 'The owner gets an email invitation. You are not added as a member.'}
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Workspace name"
            name="client-name"
            value={form.name}
            maxLength={80}
            onChange={(e) => set({ name: e.target.value })}
          />
          {!editing && (
            <FormField
              label="Owner's email"
              name="client-owner"
              type="email"
              value={form.ownerEmail}
              onChange={(e) => set({ ownerEmail: e.target.value })}
            />
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="client-plan">Plan</Label>
            <Select value={form.planCode} onValueChange={(planCode) => set({ planCode })}>
              <SelectTrigger id="client-plan" className="w-full">
                <SelectValue placeholder="Choose a plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.code} value={p.code}>
                    {p.name}, {formatMoney(p.wholesaleMicros, p.currency)} a month to you
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <FormField
            label={`What you charge this client a month (${currency})`}
            name="client-price"
            inputMode="decimal"
            value={form.clientPrice}
            placeholder={plan ? microsToDecimal(plan.wholesaleMicros) : ''}
            hint="Only used to show your margin. You bill the client yourself."
            error={priceValid ? undefined : 'Enter an amount'}
            onChange={(e) => set({ clientPrice: e.target.value })}
          />
          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-medium">
              Limits{' '}
              <span className="font-normal text-muted-foreground">(blank = the plan&apos;s)</span>
            </legend>
            {PLAN_LIMITS.map((l: PlanLimit) => (
              <FormField
                key={l}
                label={PLAN_LIMIT_LABELS[l].replace(/^./, (c) => c.toUpperCase())}
                name={`client-limit-${l}`}
                inputMode="numeric"
                value={form[l]}
                placeholder={plan ? limitText(plan[l]) : ''}
                error={validLimit(form[l]) ? undefined : 'A whole number'}
                onChange={(e) => set({ [l]: e.target.value })}
              />
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {editing ? 'Save' : 'Create and invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Clients({ partner }: { partner: PartnerDto }) {
  const queryClient = useQueryClient();
  const clients = useClients();
  const plans = usePartnerPlans();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ClientDto | null>(null);
  const [viewing, setViewing] = useState<WorkspaceRef | null>(null);
  const [crediting, setCrediting] = useState<WorkspaceRef | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: partnerKeys.all });
  const act = async (path: string, method: 'POST' | 'DELETE', done: string, body?: unknown) => {
    try {
      await api(path, { method, body });
      await refresh();
      toast.success(done);
    } catch (err) {
      handleApiError(err);
    }
  };

  const resend = (c: ClientDto) => {
    const email = window.prompt('Send the owner invitation to:', c.ownerEmail ?? '');
    if (email) {
      void act(`/partner/clients/${c.id}/invite-owner`, 'POST', `Invitation sent to ${email}`, {
        email: email.trim(),
      });
    }
  };
  const remove = (c: ClientDto) => {
    const sure = window.confirm(
      `Delete ${c.name}? Its team loses access and its WhatsApp numbers are disconnected. This cannot be undone from here.`,
    );
    if (sure) void act(`/partner/clients/${c.id}`, 'DELETE', `${c.name} deleted`);
  };

  const atLimit = partner.maxClients !== null && partner.clientCount >= partner.maxClients;
  const noPlans = plans.data?.length === 0;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Client workspaces</CardTitle>
          <CardDescription>
            {partner.clientCount}
            {partner.maxClients !== null ? ` of ${partner.maxClients}` : ''} in use.
            {noPlans && ' No plans are available to you yet: ask the platform to set prices.'}
          </CardDescription>
        </div>
        <Button onClick={() => setCreating(true)} disabled={atLimit || noPlans || !plans.data}>
          New client
        </Button>
      </CardHeader>
      <CardContent>
        {clients.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : !clients.data?.length ? (
          <p className="text-sm text-muted-foreground">
            No clients yet. Create a workspace and its owner is invited by email.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Wallet</TableHead>
                <TableHead>Seats / numbers / contacts</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.data.map((c) => (
                <TableRow key={c.id} data-testid={`client-${c.name}`}>
                  <TableCell>
                    <div className="font-medium">
                      {c.name}{' '}
                      {c.status === 'suspended' && <Badge variant="destructive">Suspended</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{c.ownerEmail}</div>
                  </TableCell>
                  <TableCell>{c.planName ?? 'None'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(c.balanceMicros, c.currency)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {PLAN_LIMITS.map((l) => limitText(c.limits[l])).join(' / ')}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${c.name}`}>
                          <MoreHorizontal className="size-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setViewing(c)}>
                          View workspace
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setCrediting(c)}>
                          Add funds
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setEditing(c)}>
                          Edit plan and limits
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => resend(c)}>
                          Invite an owner
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {c.status === 'active' ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              void act(
                                `/partner/clients/${c.id}/suspend`,
                                'POST',
                                `${c.name} suspended`,
                              )
                            }
                          >
                            Suspend
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onSelect={() =>
                              void act(
                                `/partner/clients/${c.id}/resume`,
                                'POST',
                                `${c.name} restored`,
                              )
                            }
                          >
                            Restore access
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem variant="destructive" onSelect={() => remove(c)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ClientDialog
        open={creating || editing !== null}
        editing={editing}
        plans={plans.data ?? []}
        currency={partner.currency}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ImpersonateDialog
        workspace={viewing}
        basePath="/partner/clients"
        returnTo="/partner"
        onClose={() => setViewing(null)}
      />
      <CreditDialog
        workspace={crediting}
        basePath="/partner/clients"
        currency={partner.currency}
        description="Use this once you have collected the money from your client. The amount is theirs to spend at your prices, and what they use is added to your statement at wholesale."
        onClose={() => setCrediting(null)}
        onDone={() => void refresh()}
      />
    </Card>
  );
}

function Ledger({ currency }: { currency: string }) {
  const ledger = usePartnerLedger();
  const rows = ledger.data?.pages.flatMap((p) => p.items) ?? [];
  const money = (micros: number) => formatMoney(micros, currency);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ledger</CardTitle>
        <CardDescription>
          Every client charge and plan fee: what it costs you, what the client pays, and the
          difference.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {ledger.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Wholesale</TableHead>
                <TableHead className="text-right">Client price</TableHead>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{dateText(r.createdAt)}</TableCell>
                  <TableCell>{r.orgName ?? 'Deleted workspace'}</TableCell>
                  <TableCell>{LEDGER_LABELS[r.type] ?? r.type}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(r.wholesaleMicros)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.retailMicros)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(r.commissionMicros)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {ledger.hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            disabled={ledger.isFetchingNextPage}
            onClick={() => void ledger.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Statements() {
  const statements = usePartnerStatements();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Statements</CardTitle>
        <CardDescription>
          One for each finished month. The total is what the platform invoices you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {statements.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : !statements.data?.length ? (
          <p className="text-sm text-muted-foreground">
            Your first statement appears after the end of your first month.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Usage</TableHead>
                <TableHead className="text-right">Plans</TableHead>
                <TableHead className="text-right">Total due</TableHead>
                <TableHead className="text-right">Your margin</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statements.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.period}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(s.usageWholesaleMicros, s.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(s.planFeesWholesaleMicros, s.currency)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(s.totalDueMicros, s.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(s.commissionMicros, s.currency)}
                  </TableCell>
                  <TableCell>
                    {s.status === 'paid' ? (
                      <Badge variant="secondary">Paid {s.paidAt ? dateText(s.paidAt) : ''}</Badge>
                    ) : (
                      <Badge variant="outline">Awaiting payment</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function PartnerPage() {
  const partner = usePartner();
  if (partner.isPending) return <Skeleton className="h-40 w-full" />;
  if (!partner.data) {
    return (
      <p className="text-sm text-muted-foreground">
        This partner account is not available. It may have been suspended.
      </p>
    );
  }
  const p = partner.data;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          Partner console. Markup {percentOf(p.walletMarkupBps)}, billed in {p.currency}.
        </p>
      </div>
      <Overview partner={p} />
      <Tabs defaultValue="clients">
        <TabsList>
          <TabsTrigger value="clients">Clients</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="statements">Statements</TabsTrigger>
        </TabsList>
        <TabsContent value="clients">
          <Clients partner={p} />
        </TabsContent>
        <TabsContent value="ledger">
          <Ledger currency={p.currency} />
        </TabsContent>
        <TabsContent value="statements">
          <Statements />
        </TabsContent>
      </Tabs>
    </div>
  );
}

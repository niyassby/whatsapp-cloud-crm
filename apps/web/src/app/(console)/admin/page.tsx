'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type AdminOrgDto,
  type AdminPlanDto,
  formatMoney,
  microsToDecimal,
  type PartnerDto,
  type PartnerStatementDto,
  PLAN_FEATURE_LABELS,
  PLAN_FEATURES,
  PLAN_LIMIT_LABELS,
  PLAN_LIMITS,
  type PlanFeature,
} from '@wacrm/shared';
import { MoreHorizontal } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
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
  adminKeys,
  percentOf,
  useAdminMembers,
  useAdminOrgs,
  useAdminPartners,
  useAdminPlans,
  useAdminRates,
  useAdminStatements,
  useSystemStatus,
} from '@/lib/reseller';

const dateText = (iso: string) => new Date(iso).toLocaleDateString();

/** Run a change, refresh the admin data, and say what happened. */
function useAct() {
  const queryClient = useQueryClient();
  return async (
    path: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body: unknown,
    done: string,
  ): Promise<boolean> => {
    try {
      await api(path, { method, body });
      await queryClient.invalidateQueries({ queryKey: adminKeys.all });
      toast.success(done);
      return true;
    } catch (err) {
      handleApiError(err);
      return false;
    }
  };
}

// ------------------------------------------------------------------ partners

function NewPartner({ open, onClose }: { open: boolean; onClose: () => void }) {
  const act = useAct();
  const [form, setForm] = useState({ name: '', currency: 'INR', maxClients: '', adminEmail: '' });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await act(
      '/admin/partners',
      'POST',
      {
        name: form.name.trim(),
        currency: form.currency.trim(),
        maxClients: form.maxClients.trim() === '' ? null : Number(form.maxClients),
        ...(form.adminEmail.trim() ? { adminEmail: form.adminEmail.trim() } : {}),
      },
      'Partner created',
    );
    setBusy(false);
    if (ok) {
      setForm({ name: '', currency: 'INR', maxClients: '', adminEmail: '' });
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New partner</DialogTitle>
            <DialogDescription>
              A reseller that creates and manages client workspaces, and is invoiced at wholesale.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Name"
            name="partner-name"
            value={form.name}
            maxLength={80}
            onChange={(e) => set({ name: e.target.value })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Currency"
              name="partner-currency"
              value={form.currency}
              maxLength={3}
              hint="Fixed once created."
              onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
            />
            <FormField
              label="Client limit"
              name="partner-max"
              inputMode="numeric"
              value={form.maxClients}
              placeholder="No limit"
              onChange={(e) => set({ maxClients: e.target.value })}
            />
          </div>
          <FormField
            label="First staff member's email"
            name="partner-admin"
            type="email"
            value={form.adminEmail}
            hint="Must already have an account. More can be added later."
            onChange={(e) => set({ adminEmail: e.target.value })}
          />
          <DialogFooter>
            <Button
              type="submit"
              disabled={busy || form.name.trim().length < 2 || !/^[A-Z]{3}$/.test(form.currency)}
            >
              Create partner
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Staff({ partner, onClose }: { partner: PartnerDto | null; onClose: () => void }) {
  const act = useAct();
  const members = useAdminMembers(partner?.id ?? null);
  const [email, setEmail] = useState('');
  const base = `/admin/partners/${partner?.id}/members`;

  return (
    <Dialog open={partner !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Staff of {partner?.name}</DialogTitle>
          <DialogDescription>
            They can manage this partner&apos;s clients and view their workspaces.
          </DialogDescription>
        </DialogHeader>
        {members.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !members.data?.length ? (
          <p className="text-sm text-muted-foreground">Nobody yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {members.data.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{m.name}</span>
                  <span className="block truncate text-muted-foreground">{m.email}</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void act(`${base}/${m.userId}`, 'DELETE', undefined, `${m.name} removed`)
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(base, 'POST', { email: email.trim() }, 'Added').then(
              (ok) => ok && setEmail(''),
            );
          }}
        >
          <div className="flex-1">
            <FormField
              label="Add by email"
              name="staff-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={!/.+@.+\..+/.test(email)}>
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Partners() {
  const act = useAct();
  const partners = useAdminPartners();
  const [creating, setCreating] = useState(false);
  const [staffOf, setStaffOf] = useState<PartnerDto | null>(null);

  const setLimit = (p: PartnerDto) => {
    const text = window.prompt(
      `Client limit for ${p.name} (blank for no limit):`,
      p.maxClients?.toString() ?? '',
    );
    if (text === null) return;
    const maxClients = text.trim() === '' ? null : Number(text);
    if (maxClients !== null && !Number.isInteger(maxClients)) return;
    void act(`/admin/partners/${p.id}`, 'PATCH', { maxClients }, 'Limit saved');
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Partners</CardTitle>
          <CardDescription>Resellers and how many client workspaces each has.</CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}>New partner</Button>
      </CardHeader>
      <CardContent>
        {partners.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : !partners.data?.length ? (
          <p className="text-sm text-muted-foreground">No partners yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Partner</TableHead>
                <TableHead>Clients</TableHead>
                <TableHead>Markup</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {partners.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    {p.name}{' '}
                    {p.status === 'suspended' && <Badge variant="destructive">Suspended</Badge>}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {p.clientCount}
                    {p.maxClients !== null ? ` of ${p.maxClients}` : ''}
                  </TableCell>
                  <TableCell className="tabular-nums">{percentOf(p.walletMarkupBps)}</TableCell>
                  <TableCell>{p.currency}</TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${p.name}`}>
                          <MoreHorizontal className="size-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setStaffOf(p)}>Staff</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setLimit(p)}>
                          Change client limit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            void act(
                              `/admin/partners/${p.id}`,
                              'PATCH',
                              { status: p.status === 'active' ? 'suspended' : 'active' },
                              p.status === 'active' ? `${p.name} suspended` : `${p.name} restored`,
                            )
                          }
                        >
                          {p.status === 'active' ? 'Suspend console access' : 'Restore access'}
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
      <NewPartner open={creating} onClose={() => setCreating(false)} />
      <Staff partner={staffOf} onClose={() => setStaffOf(null)} />
    </Card>
  );
}

// ------------------------------------------------------------------ workspaces

function Workspaces() {
  const act = useAct();
  const queryClient = useQueryClient();
  const plans = useAdminPlans();
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const orgs = useAdminOrgs(search);
  const [viewing, setViewing] = useState<WorkspaceRef | null>(null);
  const [crediting, setCrediting] = useState<AdminOrgDto | null>(null);
  const rows = orgs.data?.pages.flatMap((p) => p.items) ?? [];

  const setPlan = (o: AdminOrgDto) => {
    const codes = plans.data?.map((p) => p.code).join(', ') ?? '';
    const planCode = window.prompt(`Plan for ${o.name} (${codes}):`, o.planCode ?? '');
    if (planCode) {
      void act(`/admin/orgs/${o.id}/plan`, 'PATCH', { planCode: planCode.trim() }, 'Plan set');
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>Every organization, newest first.</CardDescription>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(typed.trim());
          }}
        >
          <Input
            aria-label="Search workspaces"
            placeholder="Name or slug"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {orgs.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspaces match.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Partner</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Wallet</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <div className="font-medium">
                      {o.name}{' '}
                      {o.deleted ? (
                        <Badge variant="outline">Deleted</Badge>
                      ) : (
                        o.status === 'suspended' && <Badge variant="destructive">Suspended</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{o.slug}</div>
                  </TableCell>
                  <TableCell>{o.partnerName ?? 'Direct'}</TableCell>
                  <TableCell>{o.planCode ?? 'None'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {o.balanceMicros !== null && o.currency
                      ? formatMoney(o.balanceMicros, o.currency)
                      : 'No wallet'}
                  </TableCell>
                  <TableCell>{dateText(o.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {!o.deleted && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${o.name}`}>
                            <MoreHorizontal className="size-4" aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setViewing(o)}>
                            View workspace
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setCrediting(o)}>
                            Credit wallet
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setPlan(o)}>Set plan</DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void act(
                                `/admin/orgs/${o.id}/${o.status === 'active' ? 'suspend' : 'resume'}`,
                                'POST',
                                undefined,
                                o.status === 'active'
                                  ? `${o.name} suspended`
                                  : `${o.name} restored`,
                              )
                            }
                          >
                            {o.status === 'active' ? 'Suspend' : 'Restore access'}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {orgs.hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            disabled={orgs.isFetchingNextPage}
            onClick={() => void orgs.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </CardContent>
      <ImpersonateDialog
        workspace={viewing}
        basePath="/admin/orgs"
        returnTo="/admin"
        onClose={() => setViewing(null)}
      />
      <CreditDialog
        workspace={crediting}
        basePath="/admin/orgs"
        currency={crediting?.currency ?? ''}
        description="Recorded in the workspace's wallet as an adjustment, with your note. No payment is taken."
        onClose={() => setCrediting(null)}
        onDone={() => void queryClient.invalidateQueries({ queryKey: adminKeys.all })}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ plans and feature flags

function PlanCard({ plan }: { plan: AdminPlanDto }) {
  const act = useAct();
  const [limits, setLimits] = useState(() =>
    Object.fromEntries(PLAN_LIMITS.map((l) => [l, plan[l]?.toString() ?? ''])),
  );
  const [features, setFeatures] = useState<PlanFeature[]>(plan.features);
  const [currency, setCurrency] = useState(plan.wholesale[0]?.currency ?? 'INR');
  const [amount, setAmount] = useState('');
  const limitsValid = PLAN_LIMITS.every((l) => /^$|^[1-9]\d{0,8}$/.test((limits[l] ?? '').trim()));

  const save = () =>
    act(
      `/admin/plans/${plan.code}`,
      'PATCH',
      {
        ...Object.fromEntries(
          PLAN_LIMITS.map((l) => [l, limits[l]?.trim() ? Number(limits[l]) : null]),
        ),
        features,
      },
      `${plan.name} saved`,
    );

  return (
    <Card data-testid={`plan-${plan.code}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {plan.name}
          {plan.isTrial && <Badge variant="secondary">Trial plan</Badge>}
          {!plan.isPublic && <Badge variant="outline">Hidden</Badge>}
        </CardTitle>
        <CardDescription>{plan.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {PLAN_LIMITS.map((l) => (
            <FormField
              key={l}
              label={PLAN_LIMIT_LABELS[l].replace(/^./, (c) => c.toUpperCase())}
              name={`${plan.code}-${l}`}
              inputMode="numeric"
              placeholder="No limit"
              value={limits[l] ?? ''}
              onChange={(e) => setLimits((v) => ({ ...v, [l]: e.target.value }))}
            />
          ))}
        </div>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium">Features</legend>
          {PLAN_FEATURES.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={features.includes(f)}
                onChange={(e) =>
                  setFeatures((all) =>
                    e.target.checked ? [...all, f] : all.filter((x) => x !== f),
                  )
                }
              />
              {PLAN_FEATURE_LABELS[f]}
            </label>
          ))}
        </fieldset>
        <div>
          <Button onClick={() => void save()} disabled={!limitsValid}>
            Save limits and features
          </Button>
        </div>
        <div className="flex flex-col gap-2 border-t pt-4">
          <span className="text-sm font-medium">Wholesale price to partners, a month</span>
          <span className="text-sm text-muted-foreground">
            {plan.wholesale.length
              ? plan.wholesale.map((w) => formatMoney(w.amountMicros, w.currency)).join(', ')
              : 'Not offered to partners.'}
          </span>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                `/admin/plans/${plan.code}/wholesale`,
                'PUT',
                { currency, amount: amount.trim() === '' ? null : amount.trim() },
                'Wholesale price saved',
              ).then((ok) => ok && setAmount(''));
            }}
          >
            <div className="w-24">
              <FormField
                label="Currency"
                name={`${plan.code}-wcur`}
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
            <div className="w-36">
              <FormField
                label="Amount"
                name={`${plan.code}-wamt`}
                inputMode="decimal"
                value={amount}
                placeholder={
                  plan.wholesale.find((w) => w.currency === currency)
                    ? microsToDecimal(
                        plan.wholesale.find((w) => w.currency === currency)!.amountMicros,
                      )
                    : 'Blank removes'
                }
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <Button type="submit" variant="outline" disabled={!/^[A-Z]{3}$/.test(currency)}>
              Set price
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

function Plans() {
  const plans = useAdminPlans();
  if (plans.isPending) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {plans.data?.map((p) => (
        <PlanCard key={`${p.code}-${JSON.stringify(p)}`} plan={p} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ rate cards

function Rates() {
  const act = useAct();
  const rates = useAdminRates();
  const [form, setForm] = useState({
    country: '',
    category: 'marketing',
    currency: 'INR',
    rate: '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const ready =
    /^([A-Za-z]{2}|\*)$/.test(form.country) &&
    /^[a-z_]+$/.test(form.category) &&
    /^[A-Z]{3}$/.test(form.currency) &&
    Number(form.rate) >= 0 &&
    form.rate.trim() !== '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rate cards</CardTitle>
        <CardDescription>
          The price in force for each country and category. A new price starts now and replaces the
          old one for new charges; past charges keep the rate they were made at. AI categories are
          per million tokens.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act('/admin/rate-cards', 'POST', form, 'Rate added').then(
              (ok) => ok && set({ rate: '' }),
            );
          }}
        >
          <div className="w-24">
            <FormField
              label="Country"
              name="rate-country"
              value={form.country}
              maxLength={2}
              placeholder="IN or *"
              onChange={(e) => set({ country: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="w-40">
            <FormField
              label="Category"
              name="rate-category"
              value={form.category}
              onChange={(e) => set({ category: e.target.value.toLowerCase() })}
            />
          </div>
          <div className="w-24">
            <FormField
              label="Currency"
              name="rate-currency"
              value={form.currency}
              maxLength={3}
              onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="w-32">
            <FormField
              label="Rate"
              name="rate-amount"
              inputMode="decimal"
              value={form.rate}
              onChange={(e) => set({ rate: e.target.value })}
            />
          </div>
          <Button type="submit" disabled={!ready}>
            Add rate
          </Button>
        </form>
        {rates.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : !rates.data?.length ? (
          <p className="text-sm text-muted-foreground">
            No rates yet. Paid sends are refused until a rate exists.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Currency</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.currency}</TableCell>
                  <TableCell>{r.country === '*' ? 'Any other' : r.country}</TableCell>
                  <TableCell>{r.category}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {microsToDecimal(r.rateMicros)}
                  </TableCell>
                  <TableCell>{dateText(r.validFrom)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ statements

function Statements() {
  const act = useAct();
  const statements = useAdminStatements();

  const markPaid = (s: PartnerStatementDto) => {
    const reference = window.prompt(
      `Payment reference for ${s.partnerName}, ${s.period} (${formatMoney(s.totalDueMicros, s.currency)}):`,
    );
    if (reference?.trim()) {
      void act(
        `/admin/statements/${s.id}/paid`,
        'POST',
        { reference: reference.trim() },
        'Marked as paid',
      );
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Partner statements</CardTitle>
        <CardDescription>
          Issued for each partner after a month ends. Record a payment once it has reached you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {statements.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : !statements.data?.length ? (
          <p className="text-sm text-muted-foreground">No statements yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Partner</TableHead>
                <TableHead className="text-right">Usage</TableHead>
                <TableHead className="text-right">Plans</TableHead>
                <TableHead className="text-right">Total due</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statements.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.period}</TableCell>
                  <TableCell>{s.partnerName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(s.usageWholesaleMicros, s.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(s.planFeesWholesaleMicros, s.currency)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(s.totalDueMicros, s.currency)}
                  </TableCell>
                  <TableCell>
                    {s.status === 'paid' ? (
                      <span className="text-sm text-muted-foreground">
                        Paid {s.paidAt ? dateText(s.paidAt) : ''} ({s.paymentReference})
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => markPaid(s)}>
                        Record payment
                      </Button>
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

// ------------------------------------------------------------------ system

function Health({
  label,
  ok,
  latencyMs,
}: {
  label: string;
  ok: boolean;
  latencyMs: number | null;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span className="font-medium">{label}</span>
      {/* Words as well as color, so the state does not depend on seeing the color. */}
      <Badge variant={ok ? 'secondary' : 'destructive'}>
        {ok ? `Working, ${latencyMs} ms` : 'Not reachable'}
      </Badge>
    </div>
  );
}

function System() {
  const status = useSystemStatus();
  if (status.isPending) return <Skeleton className="h-40 w-full" />;
  if (!status.data) {
    return <p className="text-sm text-muted-foreground">Could not read the system status.</p>;
  }
  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
        <CardDescription>
          {s.counts.organizations.toLocaleString()} workspaces, {s.counts.partners.toLocaleString()}{' '}
          partners. Checked {new Date(s.checkedAt).toLocaleTimeString()}, refreshed every 10
          seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <Health label="Database" {...s.database} />
          <Health label="Redis" {...s.redis} />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Queue</TableHead>
              <TableHead className="text-right">Waiting</TableHead>
              <TableHead className="text-right">Running</TableHead>
              <TableHead className="text-right">Scheduled</TableHead>
              <TableHead className="text-right">Failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.queues.map((q) => (
              <TableRow key={q.name}>
                <TableCell className="font-medium">{q.name}</TableCell>
                <TableCell className="text-right tabular-nums">{q.waiting}</TableCell>
                <TableCell className="text-right tabular-nums">{q.active}</TableCell>
                <TableCell className="text-right tabular-nums">{q.delayed}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {q.failed > 0 ? <Badge variant="destructive">{q.failed} failed</Badge> : 0}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Platform admin</h1>
        <p className="text-sm text-muted-foreground">
          Partners, workspaces, plans, prices and the health of the system.
        </p>
      </div>
      <Tabs defaultValue="partners">
        <TabsList>
          <TabsTrigger value="partners">Partners</TabsTrigger>
          <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="rates">Rate cards</TabsTrigger>
          <TabsTrigger value="statements">Statements</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>
        <TabsContent value="partners">
          <Partners />
        </TabsContent>
        <TabsContent value="workspaces">
          <Workspaces />
        </TabsContent>
        <TabsContent value="plans">
          <Plans />
        </TabsContent>
        <TabsContent value="rates">
          <Rates />
        </TabsContent>
        <TabsContent value="statements">
          <Statements />
        </TabsContent>
        <TabsContent value="system">
          <System />
        </TabsContent>
      </Tabs>
    </div>
  );
}

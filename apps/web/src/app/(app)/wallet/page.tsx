'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  decimalToMicros,
  formatMoney,
  microsToDecimal,
  Permission,
  RATE_ANY_COUNTRY,
  WALLET_ENTRY_TYPES,
  type WalletDto,
  type WalletEntryType,
} from '@wacrm/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { api, apiDownload } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';
import {
  ENTRY_LABELS,
  useLedger,
  useRates,
  useWallet,
  useWalletUsage,
  walletKeys,
} from '@/lib/wallet';

const ALL = '__all__';
const DAY = 86_400_000;

const toDateInput = (date: Date) => date.toISOString().slice(0, 10);

function Summary({ wallet }: { wallet: WalletDto }) {
  const money = (micros: number) => formatMoney(micros, wallet.currency);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card>
        <CardHeader>
          <CardDescription>Balance</CardDescription>
          <CardTitle className="text-2xl" data-testid="wallet-balance">
            {money(wallet.balanceMicros)}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Held for campaigns</CardDescription>
          <CardTitle className="text-2xl">{money(wallet.reservedMicros)}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Available to send</CardDescription>
          <CardTitle className="text-2xl">{money(wallet.availableMicros)}</CardTitle>
        </CardHeader>
      </Card>
    </div>
  );
}

function AlertSettings({ wallet }: { wallet: WalletDto }) {
  const queryClient = useQueryClient();
  const canManage = useCan(Permission.BILLING_MANAGE);
  const saved =
    wallet.lowBalanceThresholdMicros === null
      ? ''
      : microsToDecimal(wallet.lowBalanceThresholdMicros);
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const valid = value.trim() === '' || decimalToMicros(value) !== null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/wallet', {
        method: 'PATCH',
        body: { lowBalanceThreshold: value.trim() || null },
      });
      await queryClient.invalidateQueries({ queryKey: walletKeys.wallet });
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
        <CardTitle>Low balance alert</CardTitle>
        <CardDescription>
          Owners get an email once when the balance falls below this, and a banner shows in the app.
          Paid sends stop when there is not enough left for the next one. Replies to customers are
          free and keep working.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="flex items-end gap-2">
          <div className="w-48">
            <FormField
              label={`Alert below (${wallet.currency})`}
              name="low-balance"
              value={value}
              disabled={!canManage}
              error={valid ? undefined : 'Enter an amount, like 100 or 49.50'}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Off"
            />
          </div>
          {canManage && (
            <Button type="submit" size="sm" disabled={busy || !valid || value.trim() === saved}>
              Save
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function Usage() {
  const [to] = useState(() => new Date());
  const [days, setDays] = useState('30');
  const from = useMemo(() => new Date(to.getTime() - Number(days) * DAY).toISOString(), [to, days]);
  const usage = useWalletUsage(from, to.toISOString());
  const data = usage.data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="grid gap-1.5">
          <CardTitle>Usage by category</CardTitle>
          <CardDescription>After refunds.</CardDescription>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger aria-label="Usage period" size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {usage.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : !data?.rows.length ? (
          <p className="text-sm text-muted-foreground">No charges in this period.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.category}>
                  <TableCell className="capitalize">{r.category}</TableCell>
                  <TableCell className="text-right">{r.messages.toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(r.costMicros, data.currency)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">Total</TableCell>
                <TableCell />
                <TableCell className="text-right font-medium">
                  {formatMoney(data.totalMicros, data.currency)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Rates({ currency }: { currency: string }) {
  const rates = useRates();
  if (!rates.data?.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Current prices</CardTitle>
        <CardDescription>
          Per message. Utility templates inside a 24-hour window and replies to customers are free.
        </CardDescription>
      </CardHeader>
      <CardContent className="max-h-72 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Country</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.data.map((r) => (
              <TableRow key={`${r.country}:${r.category}`}>
                <TableCell>
                  {r.country === RATE_ANY_COUNTRY ? 'Other countries' : r.country}
                </TableCell>
                <TableCell className="capitalize">{r.category}</TableCell>
                <TableCell className="text-right">{formatMoney(r.rateMicros, currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Ledger({ currency }: { currency: string }) {
  const [type, setType] = useState<WalletEntryType>();
  const ledger = useLedger(type);
  const items = ledger.data?.pages.flatMap((p) => p.items) ?? [];
  const [from, setFrom] = useState(() => toDateInput(new Date(Date.now() - 30 * DAY)));
  const [to, setTo] = useState(() => toDateInput(new Date()));
  const [exporting, setExporting] = useState(false);

  const download = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({
        from: new Date(`${from}T00:00:00Z`).toISOString(),
        to: new Date(`${to}T23:59:59Z`).toISOString(),
      });
      await apiDownload(`/wallet/ledger/export?${params}`, `wallet-ledger-${from}-to-${to}.csv`);
    } catch (err) {
      handleApiError(err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ledger</CardTitle>
        <CardDescription>
          Every movement of money. Entries are never changed: a correction is a new entry.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Select
            value={type ?? ALL}
            onValueChange={(v) => setType(v === ALL ? undefined : (v as WalletEntryType))}
          >
            <SelectTrigger aria-label="Filter by type" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All entries</SelectItem>
              {WALLET_ENTRY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {ENTRY_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <FormField
              label="From"
              name="export-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <FormField
              label="To"
              name="export-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={exporting || !from || !to}
              onClick={() => void download()}
            >
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </div>
        </div>
        {ledger.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{ENTRY_LABELS[e.type]}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {[
                      e.rate?.category,
                      e.rate?.country && e.rate.country !== RATE_ANY_COUNTRY
                        ? e.rate.country
                        : null,
                      e.description,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </TableCell>
                  <TableCell
                    className={`text-right ${e.amountMicros > 0 ? 'text-emerald-700 dark:text-emerald-400' : ''}`}
                  >
                    {e.amountMicros > 0 ? '+' : ''}
                    {formatMoney(e.amountMicros, currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(e.balanceAfterMicros, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {ledger.hasNextPage && (
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="outline"
              disabled={ledger.isFetchingNextPage}
              onClick={() => void ledger.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function WalletPage() {
  const canRead = useCan(Permission.WALLET_READ);
  const wallet = useWallet(canRead);

  if (!canRead) {
    return (
      <p className="text-sm text-muted-foreground">Only owners and admins can see the wallet.</p>
    );
  }
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <h1 className="text-2xl font-semibold">Wallet</h1>
      {wallet.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : wallet.isError || !wallet.data ? (
        <p className="text-sm text-destructive">Could not load the wallet.</p>
      ) : (
        <>
          <Summary wallet={wallet.data} />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Usage />
            <div className="grid gap-4">
              <AlertSettings
                key={wallet.data.lowBalanceThresholdMicros ?? 'off'}
                wallet={wallet.data}
              />
              <Rates currency={wallet.data.currency} />
            </div>
          </div>
          <Ledger currency={wallet.data.currency} />
        </>
      )}
    </div>
  );
}

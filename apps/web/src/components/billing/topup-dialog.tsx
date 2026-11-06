'use client';

import { decimalToMicros, formatMoney } from '@wacrm/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useTopupQuote } from '@/lib/billing';
import { handleApiError } from '@/lib/forms';

export function TopupDialog({
  open,
  onClose,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
}) {
  const [amount, setAmount] = useState('1000');
  const [settled, setSettled] = useState('1000');
  const [busy, setBusy] = useState(false);

  // Quote what they stopped typing, rather than asking on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSettled(amount.trim()), 300);
    return () => clearTimeout(timer);
  }, [amount]);

  const micros = decimalToMicros(amount.trim());
  const valid = micros !== null && micros >= 1_000_000;
  const settledMicros = decimalToMicros(settled);
  const quote = useTopupQuote(
    settled,
    open && settledMicros !== null && settledMicros >= 1_000_000,
  );
  const money = (value: number) => formatMoney(value, currency);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/billing/topups', {
        method: 'POST',
        body: { amount: amount.trim() },
      });
      window.location.assign(url);
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
            <DialogTitle>Add funds</DialogTitle>
            <DialogDescription>
              The balance updates once the payment is confirmed, usually within a few seconds.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label={`Amount to add (${currency})`}
            name="topup-amount"
            inputMode="decimal"
            value={amount}
            error={amount.trim() && !valid ? 'Enter an amount of at least 1' : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
          {valid && quote.data && (
            <dl className="grid grid-cols-2 gap-1 text-sm" data-testid="topup-quote">
              <dt className="text-muted-foreground">Added to wallet</dt>
              <dd className="text-right tabular-nums">{money(quote.data.creditMicros)}</dd>
              <dt className="text-muted-foreground">
                {quote.data.taxLabel
                  ? `${quote.data.taxLabel} (${quote.data.taxRateBps / 100}%)`
                  : 'Tax'}
              </dt>
              <dd className="text-right tabular-nums">{money(quote.data.taxMicros)}</dd>
              <dt className="font-medium">You pay</dt>
              <dd className="text-right font-medium tabular-nums">
                {money(quote.data.totalMicros)}
              </dd>
            </dl>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy || !valid}>
              {busy ? 'Opening payment…' : 'Continue to payment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogDto, ConversationDto, MessageDto, SendProductsInput } from '@wacrm/shared';
import { ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { upsertMessage } from '@/lib/inbox';

/** Pick products from the synced catalog: one is a product message, several a product list. */
export function ProductsDialog({
  conversation,
  disabled,
}: {
  conversation: ConversationDto;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const phoneId = conversation.phoneNumber?.id;
  const catalog = useQuery({
    queryKey: ['catalog', phoneId],
    enabled: open && Boolean(phoneId),
    queryFn: () => api<CatalogDto>(`/catalog?phoneId=${phoneId}`),
  });

  const send = async (input: SendProductsInput) => {
    setBusy(true);
    try {
      const message = await api<MessageDto>(`/inbox/conversations/${conversation.id}/products`, {
        method: 'POST',
        body: input,
      });
      upsertMessage(queryClient, message);
      setOpen(false);
      setPicked([]);
      setText('');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const sendPicked = () => {
    const clientMessageId = crypto.randomUUID();
    const body = text.trim();
    if (picked.length === 1) {
      void send({
        kind: 'product',
        clientMessageId,
        retailerId: picked[0]!,
        body: body || undefined,
      });
    } else {
      void send({
        kind: 'product_list',
        clientMessageId,
        header: 'Products for you',
        body: body || 'Here are some products you may like.',
        sections: [{ title: 'Products', retailerIds: picked }],
      });
    }
  };

  const products = (catalog.data?.products ?? []).filter((p) =>
    `${p.name} ${p.retailerId}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Send products" disabled={disabled}>
          <ShoppingBag className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send products</DialogTitle>
          <DialogDescription>
            Choose up to 30 products from your catalog, or send the whole catalog to browse.
          </DialogDescription>
        </DialogHeader>
        {catalog.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : !catalog.data?.catalogId ? (
          <p className="text-sm text-muted-foreground">
            No catalog is synced for this number. An admin can sync it in Settings &gt; WhatsApp
            tools.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <Input
              aria-label="Search products"
              placeholder="Search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border">
              {products.map((p) => (
                <li key={p.retailerId}>
                  <label className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.includes(p.retailerId)}
                      disabled={!picked.includes(p.retailerId) && picked.length >= 30}
                      onChange={(e) =>
                        setPicked((all) =>
                          e.target.checked
                            ? [...all, p.retailerId]
                            : all.filter((x) => x !== p.retailerId),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="text-muted-foreground tabular-nums">{p.price}</span>
                  </label>
                </li>
              ))}
              {products.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">No products match.</li>
              )}
            </ul>
            <Input
              aria-label="Message with the products"
              placeholder="A message to go with them (optional)"
              maxLength={1024}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={busy || !catalog.data?.catalogId}
            onClick={() =>
              void send({
                kind: 'catalog',
                clientMessageId: crypto.randomUUID(),
                body: text.trim() || 'Browse our catalog.',
              })
            }
          >
            Send whole catalog
          </Button>
          <Button disabled={busy || picked.length === 0} onClick={sendPicked}>
            Send {picked.length || ''} {picked.length === 1 ? 'product' : 'products'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

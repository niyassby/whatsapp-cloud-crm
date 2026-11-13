'use client';

import { useQuery } from '@tanstack/react-query';
import type { MediaUrlDto, MessageDto } from '@wacrm/shared';
import { AlertCircle, Check, CheckCheck, Clock, FileText, Lock, Phone } from 'lucide-react';
import { api } from '@/lib/api';
import { timeLabel } from '@/lib/inbox';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
};

function Ticks({ status }: { status: MessageDto['status'] }) {
  const label = STATUS_LABEL[status] ?? status;
  const props = { className: 'size-3.5', role: 'img', 'aria-label': label };
  if (status === 'queued' || status === 'sending') return <Clock {...props} />;
  if (status === 'sent') return <Check {...props} />;
  if (status === 'delivered') return <CheckCheck {...props} />;
  if (status === 'read') {
    return <CheckCheck {...props} className="size-3.5 text-sky-500" />;
  }
  if (status === 'failed') {
    return <AlertCircle {...props} className="size-3.5 text-destructive" />;
  }
  return null;
}

function MediaPreview({ message }: { message: MessageDto }) {
  const { media, type } = message;
  const stored = media?.status === 'stored';
  // Signed links expire in 5 minutes: refetch well before that while the message is on screen.
  const link = useQuery({
    queryKey: ['inbox', 'media', message.id],
    queryFn: () =>
      api<MediaUrlDto>(
        `/inbox/conversations/${message.conversationId}/messages/${message.id}/media`,
      ),
    enabled: stored,
    staleTime: 3 * 60_000,
    refetchInterval: 4 * 60_000,
  });

  if (media?.status === 'pending') {
    return <p className="text-sm italic opacity-70">Downloading {type}…</p>;
  }
  if (media?.status === 'failed') {
    return <p className="text-sm italic opacity-70">This {type} could not be downloaded.</p>;
  }
  const url = link.data?.url;
  if (!url) return <div className="h-32 w-48 animate-pulse rounded bg-black/10" />;

  // A template's media header is shown by what the file is, since its type is "template".
  const kind = type === 'template' ? media?.mimeType?.split('/')[0] : type;

  if (kind === 'image' || kind === 'sticker') {
    return (
      <img
        src={url}
        alt={message.body ?? 'Image from the conversation'}
        className="max-h-72 max-w-full rounded"
      />
    );
  }
  if (kind === 'video') {
    return <video src={url} controls className="max-h-72 max-w-full rounded" />;
  }
  if (kind === 'audio') {
    return <audio src={url} controls className="max-w-full" />;
  }
  return (
    <a
      href={url}
      className="flex items-center gap-2 rounded bg-black/5 p-2 text-sm underline dark:bg-white/10"
    >
      <FileText className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{media?.filename ?? 'Download file'}</span>
    </a>
  );
}

const TYPE_LABELS: Record<string, string> = {
  call: 'Call',
  order: 'Order',
  product: 'Product',
  product_list: 'Products',
  catalog: 'Catalog',
  call_permission_request: 'Call permission request',
};

export function MessageBubble({ message }: { message: MessageDto }) {
  const isNote = message.direction === 'internal';
  const isOutbound = message.direction === 'outbound';
  const failed = message.status === 'failed';
  const isReaction = message.type === 'reaction';

  return (
    <div
      className={cn(
        'flex max-w-[75%] flex-col',
        isOutbound || isNote ? 'items-end self-end' : 'items-start self-start',
      )}
    >
      <div
        className={cn(
          'min-w-0 rounded-lg px-3 py-1.5 shadow-xs',
          isNote &&
            'border border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-50',
          isOutbound && 'bg-emerald-100 text-emerald-950 dark:bg-emerald-900 dark:text-emerald-50',
          !isNote && !isOutbound && 'bg-background',
          failed && 'ring-1 ring-destructive',
        )}
      >
        {isNote && (
          <p className="mb-0.5 flex items-center gap-1 text-xs font-medium opacity-80">
            <Lock className="size-3" aria-hidden /> Internal note · {message.senderName}
          </p>
        )}
        {isOutbound && message.senderName && (
          <p className="mb-0.5 text-xs font-medium opacity-70">{message.senderName}</p>
        )}
        {message.media && <MediaPreview message={message} />}
        {message.type === 'template' && (
          <p className="mb-0.5 text-xs font-medium uppercase tracking-wide opacity-60">Template</p>
        )}
        {TYPE_LABELS[message.type] && (
          <p className="mb-0.5 flex items-center gap-1 text-xs font-medium uppercase tracking-wide opacity-60">
            {message.type === 'call' ? <Phone className="size-3" aria-hidden /> : null}
            {TYPE_LABELS[message.type]}
          </p>
        )}
        {message.detail?.kind === 'order' && (
          <div className="mb-1 text-sm" data-testid="order-detail">
            <ul className="list-inside list-disc">
              {message.detail.items.map((i) => (
                <li key={i.retailerId}>
                  {i.quantity} x {i.retailerId} at {i.price} {i.currency}
                </li>
              ))}
            </ul>
            <p className="mt-1 font-medium">
              Total {message.detail.total} {message.detail.currency}
            </p>
          </div>
        )}
        {message.detail?.kind === 'products' && (
          <p className="text-xs opacity-70">
            {message.detail.count} product{message.detail.count === 1 ? '' : 's'}
          </p>
        )}
        {message.body && (
          <p className={cn('whitespace-pre-wrap break-words text-sm', isReaction && 'text-2xl')}>
            {message.body}
          </p>
        )}
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] opacity-70">
          {timeLabel(message.createdAt)}
          {isOutbound && <Ticks status={message.status} />}
        </p>
      </div>
      {failed && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Not delivered: {message.errorMessage ?? 'Unknown error'}
        </p>
      )}
    </div>
  );
}

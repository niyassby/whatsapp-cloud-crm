'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { automationKeys, useNotifications } from '@/lib/automation';
import { handleApiError } from '@/lib/forms';

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString();
};

export function NotificationBell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const notifications = useNotifications(true);
  const items = notifications.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = notifications.data?.pages[0]?.unread ?? 0;

  const markRead = async (body: { ids: string[] } | { all: true }) => {
    try {
      await api('/notifications/read', { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: automationKeys.notifications });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell className="size-4" aria-hidden />
          {unread > 0 && (
            <span
              className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
              data-testid="unread-notifications"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          Notifications
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={(e) => {
                e.preventDefault();
                void markRead({ all: true });
              }}
            >
              Mark all read
            </Button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <DropdownMenuItem
                key={n.id}
                className="flex flex-col items-start gap-0.5"
                onSelect={() => {
                  if (!n.readAt) void markRead({ ids: [n.id] });
                  if (n.conversationId) router.push(`/inbox?c=${n.conversationId}`);
                }}
              >
                <span className={n.readAt ? 'text-sm' : 'text-sm font-semibold'}>{n.title}</span>
                {n.body && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">{n.body}</span>
                )}
                <span className="text-xs text-muted-foreground">{ago(n.createdAt)}</span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

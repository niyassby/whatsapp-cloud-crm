'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type MeResponse,
  type ClientToServerEvents,
  type ContactJobDto,
  ErrorCode,
  type ServerToClientEvents,
  SOCKET_PATH,
} from '@wacrm/shared';
import { type ReactNode, useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { refreshSession } from '@/lib/api';
import { activeToken, useAuthStore } from '@/lib/auth-store';
import { useCalls } from '@/lib/calls';
import { contactKeys } from '@/lib/contacts';
import { env } from '@/lib/env';
import { applyConversationUpdate, inboxKeys, upsertMessage } from '@/lib/inbox';
import { integrationKeys } from '@/lib/integrations';
import { aiKeys } from '@/lib/ai';
import { queryKeys, useMe } from '@/lib/queries';
import { templateKeys } from '@/lib/templates';
import { automationKeys } from '@/lib/automation';
import { billingKeys } from '@/lib/billing';
import { campaignKeys } from '@/lib/campaigns';
import { walletKeys } from '@/lib/wallet';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface Typist {
  userId: string;
  name: string;
  until: number;
}

interface RealtimeState {
  socket: AppSocket | null;
  connected: boolean;
  online: Record<string, true>;
  /** conversationId -> who is typing there. */
  typing: Record<string, Typist[]>;
}

export const useRealtime = create<RealtimeState>(() => ({
  socket: null,
  connected: false,
  online: {},
  typing: {},
}));

const TYPING_TTL_MS = 4000;

function setTyping(conversationId: string, typist: Omit<Typist, 'until'>, isTyping: boolean) {
  useRealtime.setState((s) => {
    const others = (s.typing[conversationId] ?? []).filter((t) => t.userId !== typist.userId);
    return {
      typing: {
        ...s.typing,
        [conversationId]: isTyping
          ? [...others, { ...typist, until: Date.now() + TYPING_TTL_MS }]
          : others,
      },
    };
  });
}

const useMeStoreUserId = (client: ReturnType<typeof useQueryClient>) =>
  client.getQueryData<MeResponse>(queryKeys.me)?.user.id;

/** One socket per signed-in workspace. Switching workspace connects to the new org's room. */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const orgId = me?.currentOrg?.id;

  useEffect(() => {
    if (!orgId) return;
    const socket: AppSocket = io(env.NEXT_PUBLIC_API_URL, {
      path: SOCKET_PATH,
      // A function, so every reconnect uses the current access token.
      auth: (cb) => cb({ token: activeToken() }),
    });
    useRealtime.setState({ socket });

    // Batches the re-sort of the list when many events arrive together.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const campaignRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    const refreshLists = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.lists });
      }, 300);
    };

    const reconnectWithFreshToken = () => {
      // An impersonation token is never renewed; the next API call closes the view.
      if (useAuthStore.getState().impersonation) return;
      void refreshSession().then((ok) => {
        if (ok) socket.connect();
      });
    };

    socket.on('connect', () => {
      useRealtime.setState({ connected: true });
      // Events may have been missed while offline: the server is the source of truth.
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      void queryClient.invalidateQueries({ queryKey: contactKeys.all });
      void queryClient.invalidateQueries({ queryKey: templateKeys.all });
      void queryClient.invalidateQueries({ queryKey: walletKeys.all });
    });
    socket.on('disconnect', (reason) => {
      useRealtime.setState({ connected: false });
      // The server closed it (token expired, or access changed). socket.io will not retry this
      // on its own, and the fresh handshake re-checks the session and membership. Re-reading
      // who we are also updates the screen at once if this person was just removed.
      if (reason === 'io server disconnect') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
        reconnectWithFreshToken();
      }
    });
    socket.on('connect_error', (err) => {
      if (err.message === ErrorCode.UNAUTHENTICATED) {
        setTimeout(reconnectWithFreshToken, 1000);
      }
      if (err.message === ErrorCode.TENANT_CONTEXT_MISSING) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      }
    });

    socket.on('message:new', ({ message }) => upsertMessage(queryClient, message));
    socket.on('message:updated', ({ message }) => upsertMessage(queryClient, message));
    socket.on('conversation:updated', ({ conversation }) => {
      applyConversationUpdate(queryClient, conversation);
      refreshLists();
    });
    socket.on('integration:updated', ({ connectionId }) => {
      void queryClient.invalidateQueries({ queryKey: integrationKeys.connections });
      void queryClient.invalidateQueries({ queryKey: integrationKeys.connection(connectionId) });
      void queryClient.invalidateQueries({ queryKey: integrationKeys.events(connectionId) });
    });
    socket.on('knowledge:updated', () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.knowledge });
      // Reading a document is charged and logged.
      void queryClient.invalidateQueries({ queryKey: aiKeys.log });
    });
    socket.on('contact:updated', () => {
      void queryClient.invalidateQueries({ queryKey: contactKeys.all });
      // Consent shows on the conversation, and a merge moves threads.
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    });
    socket.on('contact-job:updated', ({ job }) => {
      queryClient.setQueryData<ContactJobDto[]>(contactKeys.jobs, (jobs) =>
        jobs?.some((j) => j.id === job.id)
          ? jobs.map((j) => (j.id === job.id ? job : j))
          : [job, ...(jobs ?? [])],
      );
      if (job.kind === 'import' && job.status === 'completed') {
        void queryClient.invalidateQueries({ queryKey: contactKeys.lists });
        void queryClient.invalidateQueries({ queryKey: ['contacts', 'count'] });
        void queryClient.invalidateQueries({ queryKey: contactKeys.tags });
      }
    });
    // A big campaign fires this for every batch and every delivery receipt, so refetch at most
    // once a second per campaign. The recipient list refreshes on its own timer.
    socket.on('campaign:updated', ({ campaignId }) => {
      if (campaignRefreshes.has(campaignId)) return;
      campaignRefreshes.set(
        campaignId,
        setTimeout(() => {
          campaignRefreshes.delete(campaignId);
          void queryClient.invalidateQueries({ queryKey: campaignKeys.report(campaignId) });
          void queryClient.invalidateQueries({ queryKey: campaignKeys.lists });
        }, 1000),
      );
    });
    // Sent to the whole org with only who it is for. Only that person fetches it.
    socket.on('notification:new', ({ userId }) => {
      if (userId === useMeStoreUserId(queryClient)) {
        void queryClient.invalidateQueries({ queryKey: automationKeys.notifications });
      }
    });
    socket.on('call:updated', (e) => useCalls.getState().onUpdate(e));
    socket.on('channel:updated', () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
    });
    socket.on('billing:updated', () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
    });
    socket.on('wallet:updated', () => {
      void queryClient.invalidateQueries({ queryKey: walletKeys.all });
    });
    socket.on('template:updated', () => {
      void queryClient.invalidateQueries({ queryKey: templateKeys.all });
      // The inbox picker lists approved templates.
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'templates'] });
    });
    socket.on('typing', ({ conversationId, userId, name, isTyping }) => {
      setTyping(conversationId, { userId, name }, isTyping);
    });
    socket.on('presence:state', ({ userIds }) => {
      useRealtime.setState({ online: Object.fromEntries(userIds.map((id) => [id, true])) });
    });
    socket.on('presence', ({ userId, online }) => {
      useRealtime.setState((s) => {
        const next = { ...s.online };
        if (online) next[userId] = true;
        else delete next[userId];
        return { online: next };
      });
    });

    // A typist whose "stopped" event was lost must not show as typing forever.
    const sweeper = setInterval(() => {
      const now = Date.now();
      useRealtime.setState((s) => {
        const typing = Object.fromEntries(
          Object.entries(s.typing)
            .map(([id, list]) => [id, list.filter((t) => t.until > now)] as const)
            .filter(([, list]) => list.length > 0),
        );
        return Object.keys(typing).length === Object.keys(s.typing).length ? s : { typing };
      });
    }, 1000);

    return () => {
      clearInterval(sweeper);
      clearTimeout(refreshTimer);
      campaignRefreshes.forEach((timer) => clearTimeout(timer));
      socket.disconnect();
      useRealtime.setState({ socket: null, connected: false, online: {}, typing: {} });
    };
  }, [orgId, queryClient]);

  return <>{children}</>;
}

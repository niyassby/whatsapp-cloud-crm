import type { ContactJobDto } from './contacts';
import type { ConversationDto, MessageDto } from './inbox';

/** Socket.IO rooms. Every tenant event goes to one org room, so it cannot reach another org. */
export const orgRoom = (orgId: string) => `org:${orgId}`;
export const userRoom = (userId: string) => `user:${userId}`;

export const SOCKET_PATH = '/socket.io';

export const RealtimeEvent = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  CONVERSATION_UPDATED: 'conversation:updated',
  /** Client -> server, then server -> the rest of the org. */
  TYPING: 'typing',
  PRESENCE: 'presence',
  PRESENCE_STATE: 'presence:state',
} as const;

export interface ServerToClientEvents {
  'message:new': (e: { message: MessageDto }) => void;
  'message:updated': (e: { message: MessageDto }) => void;
  'conversation:updated': (e: { conversation: ConversationDto }) => void;
  typing: (e: { conversationId: string; userId: string; name: string; isTyping: boolean }) => void;
  presence: (e: { userId: string; online: boolean }) => void;
  'presence:state': (e: { userIds: string[] }) => void;
  'contact:updated': (e: { contactId: string }) => void;
  'contact-job:updated': (e: { job: ContactJobDto }) => void;
  'template:updated': (e: { templateId: string | null }) => void;
  'wallet:updated': () => void;
}

export interface ClientToServerEvents {
  typing: (e: { conversationId: string; isTyping: boolean }) => void;
}

/** Tenant events that both the API and the worker publish. */
export interface TenantEventMap {
  'message:new': { message: MessageDto };
  'message:updated': { message: MessageDto };
  'conversation:updated': { conversation: ConversationDto };
  'contact:updated': { contactId: string };
  'contact-job:updated': { job: ContactJobDto };
  /** Null when many may have changed, after a sync. */
  'template:updated': { templateId: string | null };
  'wallet:updated': Record<string, never>;
}

/** Publish to everyone in an org. API: Socket.IO server. Worker: Redis emitter. */
export interface RealtimePublisher {
  emit<E extends keyof TenantEventMap>(orgId: string, event: E, payload: TenantEventMap[E]): void;
}

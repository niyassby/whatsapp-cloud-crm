import type { ContactJobDto } from './contacts';
import type { ConversationDto, MessageDto } from './inbox';
import type { WebchatMessageDto } from './channels';
import type { CallDto } from './wa-modules';

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
  'campaign:updated': (e: { campaignId: string }) => void;
  'billing:updated': (e: Record<string, never>) => void;
  'notification:new': (e: { userId: string }) => void;
  'integration:updated': (e: { connectionId: string }) => void;
  'knowledge:updated': (e: { documentId: string }) => void;
  'call:updated': (e: { call: CallDto; offer?: string; answer?: string }) => void;
  'channel:updated': (e: { channelId: string }) => void;
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
  'campaign:updated': { campaignId: string };
  'billing:updated': Record<string, never>;
  /** To the org's room, carrying only who it is for. That person fetches it with their own access. */
  'notification:new': { userId: string };
  'integration:updated': { connectionId: string };
  'knowledge:updated': { documentId: string };
  /** offer: an inbound call's SDP. answer: Meta's answer to a call an agent started. */
  'call:updated': { call: CallDto; offer?: string; answer?: string };
  'channel:updated': { channelId: string };
}

/** Publish to everyone in an org. API: Socket.IO server. Worker: Redis emitter. */
export interface RealtimePublisher {
  emit<E extends keyof TenantEventMap>(orgId: string, event: E, payload: TenantEventMap[E]): void;
  /** To the website visitor in this conversation, on the /webchat namespace. */
  emitVisitor(conversationId: string, message: WebchatMessageDto): void;
}

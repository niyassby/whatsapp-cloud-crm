import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { withTenant } from '@wacrm/db';
import {
  type ClientToServerEvents,
  ErrorCode,
  orgRoom,
  type RealtimePublisher,
  type ServerToClientEvents,
  SOCKET_PATH,
  type TenantEventMap,
  userRoom,
} from '@wacrm/shared';
import type { Server, Socket } from 'socket.io';
import { AuthenticatorService } from '../auth/authenticator.service';
import { PrismaService } from '../db/prisma.service';

interface SocketData {
  userId: string;
  orgId: string;
  name: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

type AppServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

const sessionRoom = (sessionId: string) => `session:${sessionId}`;
const memberRoom = (orgId: string, userId: string) => `member:${orgId}:${userId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Org rooms over Socket.IO. A socket joins exactly one org room, chosen by its verified access
 * token, and every tenant event is sent to one org room. Fan-out across API instances and from
 * the worker goes through the Redis adapter (see RealtimeIoAdapter).
 */
@Injectable()
@WebSocketGateway({ path: SOCKET_PATH })
export class RealtimeGateway
  implements RealtimePublisher, OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer() server!: AppServer;

  constructor(
    private readonly authenticator: AuthenticatorService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: AppServer): void {
    // Runs before the connection is established, so a bad token never joins a room.
    server.use((socket: AppSocket, next) => {
      void this.authorize(socket).then(
        () => next(),
        (err: unknown) => {
          const code = (err as { code?: string }).code ?? ErrorCode.UNAUTHENTICATED;
          next(new Error(code));
        },
      );
    });
  }

  private async authorize(socket: AppSocket): Promise<void> {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) throw { code: ErrorCode.UNAUTHENTICATED };
    const auth = await this.authenticator.authenticate(token);
    if (!auth.orgId) throw { code: ErrorCode.TENANT_CONTEXT_MISSING };
    if (auth.orgSuspended) throw { code: ErrorCode.ORG_SUSPENDED };
    const { orgId, userId, sessionId } = auth;

    const user = await withTenant(this.prisma.client, { orgId, userId }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } }),
    );
    socket.data.userId = userId;
    socket.data.orgId = orgId;
    socket.data.name = user.name;

    await socket.join([
      orgRoom(orgId),
      userRoom(userId),
      memberRoom(orgId, userId),
      ...(sessionId ? [sessionRoom(sessionId)] : []),
    ]);

    // The socket must not outlive its token. The client reconnects with a fresh one, which
    // re-checks the session and the membership.
    if (auth.tokenExpiresAt) {
      const ms = auth.tokenExpiresAt * 1000 - Date.now();
      socket.data.expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(ms, 0));
    }
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    const { orgId, userId } = socket.data;
    if (!orgId) return;
    const peers = await this.server.in(orgRoom(orgId)).fetchSockets();
    socket.emit('presence:state', { userIds: [...new Set(peers.map((p) => p.data.userId))] });
    socket.to(orgRoom(orgId)).emit('presence', { userId, online: true });
  }

  async handleDisconnect(socket: AppSocket): Promise<void> {
    const { orgId, userId, expiryTimer } = socket.data;
    if (expiryTimer) clearTimeout(expiryTimer);
    if (!orgId) return;
    try {
      const remaining = await this.server.in(memberRoom(orgId, userId)).fetchSockets();
      if (remaining.length === 0) {
        this.server.to(orgRoom(orgId)).emit('presence', { userId, online: false });
      }
    } catch (err) {
      // During shutdown other instances may not answer; presence simply self-corrects.
      this.logger.debug(`presence check skipped: ${String(err)}`);
    }
  }

  @SubscribeMessage('typing')
  typing(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: { conversationId?: unknown; isTyping?: unknown },
  ): void {
    const { orgId, userId, name } = socket.data;
    const { conversationId, isTyping } = body ?? {};
    if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return;
    // Only ever relayed inside the sender's own org room.
    socket.to(orgRoom(orgId)).emit('typing', {
      conversationId,
      userId,
      name,
      isTyping: Boolean(isTyping),
    });
  }

  emit<E extends keyof TenantEventMap>(orgId: string, event: E, payload: TenantEventMap[E]): void {
    const room = this.server.to(orgRoom(orgId));
    (room.emit as (e: string, p: unknown) => boolean)(event, payload);
  }

  // ------------------------------------------------------------------ revocation
  // HTTP checks the session on every request; these give sockets the same immediacy.

  disconnectSession(sessionId: string): void {
    this.server.in(sessionRoom(sessionId)).disconnectSockets(true);
  }

  disconnectUser(userId: string): void {
    this.server.in(userRoom(userId)).disconnectSockets(true);
  }

  disconnectMember(orgId: string, userId: string): void {
    this.server.in(memberRoom(orgId, userId)).disconnectSockets(true);
  }

  /** A workspace was suspended or deleted: everyone in it is cut off at once. */
  disconnectOrg(orgId: string): void {
    this.server.in(orgRoom(orgId)).disconnectSockets(true);
  }
}

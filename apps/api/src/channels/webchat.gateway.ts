import { Injectable } from '@nestjs/common';
import {
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket,
} from '@nestjs/websockets';
import { SOCKET_PATH, WEBCHAT_NAMESPACE, webchatRoom } from '@wacrm/shared';
import type { Namespace, Socket } from 'socket.io';
import { WebchatService } from './webchat.service';

interface VisitorData {
  key: string;
  token: string;
}

/**
 * Website visitors, on their own namespace. A visitor socket can only ever join the room of
 * their own conversation, found from the signed token, and it receives only what toWebchatMessage
 * lets out (no notes). The worker publishes here through the Redis emitter.
 */
@Injectable()
@WebSocketGateway({ path: SOCKET_PATH, namespace: WEBCHAT_NAMESPACE })
export class WebchatGateway implements OnGatewayInit {
  @WebSocketServer() server!: Namespace;

  constructor(private readonly webchat: WebchatService) {}

  afterInit(nsp: Namespace): void {
    nsp.use((socket: Socket, next) => {
      const { key, token } = (socket.handshake.auth ?? {}) as Partial<VisitorData>;
      if (typeof key !== 'string' || typeof token !== 'string') {
        next(new Error('UNAUTHENTICATED'));
        return;
      }
      void this.join(socket, { key, token }).then(
        () => next(),
        () => next(new Error('UNAUTHENTICATED')),
      );
    });
  }

  private async join(socket: Socket, data: VisitorData): Promise<void> {
    const { conversationId } = await this.webchat.conversationFor(data.key, data.token);
    (socket.data as VisitorData) = data;
    if (conversationId) await socket.join(webchatRoom(conversationId));
  }

  /** After the first message there is a conversation to join. */
  @SubscribeMessage('join')
  async rejoin(@ConnectedSocket() socket: Socket): Promise<void> {
    const data = socket.data as VisitorData;
    if (data?.key && data.token) await this.join(socket, data).catch(() => undefined);
  }
}

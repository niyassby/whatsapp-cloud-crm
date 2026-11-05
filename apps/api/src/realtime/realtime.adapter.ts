import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { ApiEnv } from '../env';

/**
 * Socket.IO with the Redis adapter, so events reach sockets on every API instance and the worker
 * can publish through a Redis emitter.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly env: ApiEnv,
  ) {
    super(app);
    this.pub = new Redis(env.REDIS_URL);
    this.sub = this.pub.duplicate();
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: new URL(this.env.WEB_URL).origin, credentials: true },
    } as ServerOptions) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    // quit(), not disconnect(): the adapter may still have a subscribe or unsubscribe in flight,
    // and dropping the connection under it rejects that command with nothing to catch it.
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

import { createServer } from 'node:http';
import pino from 'pino';
import { buildHealth } from '@wacrm/shared';
import { loadWorkerEnv } from './env';

const env = loadWorkerEnv();
const log = pino({ level: env.LOG_LEVEL, name: 'worker' });

// TODO(phase-1.5): register BullMQ processors (inbound, outbound, ...) here.
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildHealth('worker')));
    return;
  }
  res.writeHead(404).end();
});

server.listen(env.WORKER_HEALTH_PORT, () =>
  log.info({ port: env.WORKER_HEALTH_PORT }, 'worker started'),
);

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

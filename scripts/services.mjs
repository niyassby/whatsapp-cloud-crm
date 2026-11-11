#!/usr/bin/env node
/**
 * Local services without Docker: `pnpm services:up | down | status`.
 *
 * - Postgres (16 or later) and Redis run as Windows services you install once (see infra/native-setup.md);
 *   this only checks they answer.
 * - SeaweedFS (S3 on :9000) and Mailpit (SMTP :1025, inbox http://localhost:8025) run from
 *   .tools/, started here in the background with the same ports Docker used, so .env is the same.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, '.tools');
const run = path.join(tools, 'run');
const logs = path.join(tools, 'logs');
const data = path.join(tools, 'data');

const MANAGED = {
  seaweedfs: {
    exe: path.join(tools, 'seaweedfs', 'weed.exe'),
    port: 9000,
    args: () => [
      'server',
      '-ip=127.0.0.1',
      '-ip.bind=127.0.0.1',
      `-dir=${path.join(data, 'seaweedfs')}`,
      // Small volumes: a dev machine does not need 30 GB pre-allocated per volume.
      '-master.volumeSizeLimitMB=256',
      '-volume.max=20',
      '-s3',
      '-s3.port=9000',
      `-s3.config=${path.join(root, 'infra', 'seaweedfs', 's3.json')}`,
    ],
  },
  mailpit: {
    exe: path.join(tools, 'mailpit', 'mailpit.exe'),
    port: 1025,
    args: () => [
      '--smtp',
      '127.0.0.1:1025',
      '--listen',
      '127.0.0.1:8025',
      '--database',
      path.join(data, 'mailpit.db'),
    ],
  },
};

/** Services installed once as Windows services; checked, not started. */
const EXTERNAL = {
  postgres: { port: 5433, hint: 'PostgreSQL 16+ on port 5433 (infra/native-setup.md)' },
  redis: { port: 6379, hint: 'Memurai or another Redis on port 6379 (infra/native-setup.md)' },
};

const listening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });

const pidFile = (name) => path.join(run, `${name}.pid`);
const readPid = (name) => {
  try {
    return Number(readFileSync(pidFile(name), 'utf8').trim()) || null;
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await listening(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function up() {
  for (const dir of [run, logs, data, path.join(data, 'seaweedfs')])
    mkdirSync(dir, { recursive: true });
  for (const [name, svc] of Object.entries(MANAGED)) {
    if (await listening(svc.port)) {
      console.log(`${name}: already running on :${svc.port}`);
      continue;
    }
    if (!existsSync(svc.exe)) {
      console.error(`${name}: ${svc.exe} is missing. See infra/native-setup.md.`);
      process.exitCode = 1;
      continue;
    }
    const out = openSync(path.join(logs, `${name}.log`), 'a');
    const child = spawn(svc.exe, svc.args(), {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    writeFileSync(pidFile(name), String(child.pid));
    const ok = await waitFor(svc.port, 30_000);
    console.log(
      ok
        ? `${name}: started on :${svc.port} (pid ${child.pid})`
        : `${name}: did not answer on :${svc.port}; see .tools/logs/${name}.log`,
    );
    if (!ok) process.exitCode = 1;
  }
  await status();
}

function down() {
  for (const name of Object.keys(MANAGED)) {
    const pid = readPid(name);
    if (pid && alive(pid)) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        console.log(`${name}: stopped`);
      } catch {
        console.log(`${name}: could not stop pid ${pid}`);
      }
    } else {
      console.log(`${name}: not running`);
    }
    rmSync(pidFile(name), { force: true });
  }
}

async function status() {
  const all = { ...EXTERNAL, ...MANAGED };
  let missing = 0;
  for (const [name, svc] of Object.entries(all)) {
    const ok = await listening(svc.port);
    if (!ok) missing++;
    console.log(
      `${ok ? 'ok     ' : 'MISSING'} ${name.padEnd(9)} :${svc.port}${ok ? '' : `  ${svc.hint ?? 'run pnpm services:up'}`}`,
    );
  }
  if (missing) process.exitCode = 1;
}

const command = process.argv[2] ?? 'status';
if (command === 'up') await up();
else if (command === 'down') down();
else if (command === 'status') await status();
else {
  console.error('Usage: node scripts/services.mjs up | down | status');
  process.exit(1);
}

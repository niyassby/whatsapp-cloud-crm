#!/usr/bin/env node
/**
 * Lists every raw SQL call ($queryRaw, $executeRaw and their Unsafe forms) in application code,
 * per file, for the security review (infra/security-checklist.md). Exits 1 if an Unsafe form
 * appears outside tests: those take a string, so a value could be concatenated into the SQL.
 *
 *   node infra/scripts/raw-sql-inventory.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const SKIP = new Set(['node_modules', 'dist', 'generated', '.next', 'test', '.turbo']);
const rows = [];
const unsafe = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      const text = readFileSync(full, 'utf8');
      const calls = text.match(/\$(queryRaw|executeRaw)(Unsafe)?\b/g) ?? [];
      if (calls.length) rows.push([calls.length, path.relative(root, full).replaceAll('\\', '/')]);
      if (calls.some((c) => c.endsWith('Unsafe'))) unsafe.push(path.relative(root, full));
    }
  }
}

for (const dir of ['apps/api/src', 'apps/worker/src', 'packages']) walk(path.join(root, dir));
rows.sort((a, b) => a[1].localeCompare(b[1]));
for (const [n, file] of rows) console.log(`${String(n).padStart(3)}  ${file}`);
console.log(`${rows.reduce((s, [n]) => s + n, 0)} raw calls in ${rows.length} files`);
if (unsafe.length) {
  console.error(`Unsafe raw SQL outside tests: ${unsafe.join(', ')}`);
  process.exit(1);
}

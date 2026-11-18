#!/usr/bin/env node
/**
 * Secret scan over every file git tracks (Phase 4.4). Exits 1 on a finding. CI also runs
 * gitleaks over the history; this one is quick, has no dependencies and runs locally:
 *
 *   node infra/scripts/secret-scan.mjs
 *
 * Patterns are live credential shapes, not test values: `sk_test_` Stripe keys, the fake Meta
 * and the dev-only values in .env.example are allowed. A real finding means rotating the
 * secret, not just deleting the line: it is in the history.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

const PATTERNS = [
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ['Stripe live key', /\b(sk|rk)_live_[0-9A-Za-z]{16,}/],
  ['Stripe webhook secret', /\bwhsec_[0-9A-Za-z]{24,}/],
  ['Razorpay live key', /\brzp_live_[0-9A-Za-z]{10,}/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{40,}/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic key', /\bsk-ant-[0-9A-Za-z_-]{20,}/],
  ['OpenAI key', /\bsk-(proj-)?[0-9A-Za-z]{40,}/],
  ['Meta access token', /\bEAA[0-9A-Za-z]{80,}/],
  ['Shopify token', /\bshp(at|ca|pa|ss)_[0-9a-f]{32}\b/],
  ['SendGrid key', /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/],
];

/** Files that may hold secret-looking test values, by path. */
const ALLOWED_PATHS = [/^pnpm-lock\.yaml$/, /\.test\.ts$/, /^e2e\//, /\/test\//];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString()
  .split('\0')
  .filter(Boolean);

const findings = [];
for (const file of files) {
  // A real environment file must never be committed; .env.example holds dev-only values.
  if (/(^|\/)\.env(\.[a-z]+)?$/.test(file) && !file.endsWith('.env.example')) {
    findings.push(`${file}: an environment file is committed`);
    continue;
  }
  if (ALLOWED_PATHS.some((p) => p.test(file))) continue;
  let text;
  try {
    text = readFileSync(path.join(root, file), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue; // binary
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${i + 1}: ${name}`);
    }
  });
}

console.log(`Scanned ${files.length} tracked files.`);
if (findings.length) {
  for (const f of findings) console.error(`  ${f}`);
  console.error(
    `${findings.length} possible secret(s). Rotate any real one; it is in the history.`,
  );
  process.exit(1);
}
console.log('No secrets found.');

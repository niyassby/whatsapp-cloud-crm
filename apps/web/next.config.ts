import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Next would otherwise generate an AGENTS.md in this folder on every dev run.
  agentRules: false,
  transpilePackages: ['@wacrm/shared', '@wacrm/ui'],
};

export default config;

import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@wacrm/shared', '@wacrm/ui'],
};

export default config;

import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Next's production TS config loader compiles this file to CommonJS. Resolve
// the plain-JS helper absolutely so its synthetic module cannot rebase imports.
const { backendPaths, backendRewritePaths, backendProxyConfig } = createRequire(import.meta.url)(
  fileURLToPath(new URL('./server/backend-proxy-config.mjs', import.meta.url)),
) as typeof import('./server/backend-proxy-config.mjs');

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const backend = backendProxyConfig();

const config:NextConfig={
  reactStrictMode:true,
  poweredByHeader:false,
  devIndicators:false,
  turbopack:{root:workspaceRoot},
  outputFileTracingRoot:workspaceRoot,
  allowedDevOrigins:['localhost','127.0.0.1'],
  async rewrites() {
    // The desktop server owns these paths when no remote backend is configured.
    if (!backend) return [];
    return backendRewritePaths.map(source => ({ source, destination: backend.origin + source }));
  },
  async headers() {
    if (!backend) return [];
    return backendPaths.map(source => ({ source, headers: [
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'x-vercel-enable-rewrite-caching', value: '0' },
    ] }));
  },
};
export default config;

import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const config:NextConfig={
  reactStrictMode:true,
  poweredByHeader:false,
  devIndicators:false,
  turbopack:{root:workspaceRoot},
  outputFileTracingRoot:workspaceRoot,
  allowedDevOrigins:['localhost','127.0.0.1'],
};
export default config;

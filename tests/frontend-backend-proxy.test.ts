import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { NextRequest } from 'next/server';
import { proxy } from '../frontend/proxy.ts';
import { backendProxyConfig, isBackendPath } from '../frontend/server/backend-proxy-config.mjs';

const fixtureSecret = 'fixture-only-backend-proxy-secret-0123456789';

async function readProxyConfig(origin: string | undefined) {
  // Exercise Next's production config loader, not tsx's more permissive direct import.
  const source = `import loadConfig from 'next/dist/server/config.js';import {resolve} from 'node:path';import {checkCustomRoutes} from 'next/dist/lib/load-custom-routes.js';const config=await loadConfig.default('phase-production-server',resolve('frontend'));const rewrites=await config.rewrites(),headers=await config.headers();checkCustomRoutes(rewrites,'rewrite');checkCustomRoutes(headers,'header');console.log(JSON.stringify({rewrites,headers,env:config.env??{}}));`;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', BACKEND_PROXY_SECRET: fixtureSecret };
  if (origin === undefined) delete env.BACKEND_ORIGIN;
  else env.BACKEND_ORIGIN = origin;
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += String(value));
    child.stderr.on('data', value => stderr += String(value));
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Frontend proxy configuration check timed out.')); }, 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', status => { clearTimeout(timeout); done({ status, stdout, stderr }); });
  });
}

test('frontend leaves desktop API and media routing untouched without BACKEND_ORIGIN', async () => {
  for (const origin of [undefined, '', '  ']) {
    const result = await readProxyConfig(origin);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { rewrites: [], headers: [], env: {} });
  }
});

test('configured remote backend receives only API, authenticated media and health paths without caching', async () => {
  const result = await readProxyConfig(' https://temporary.example.test:8443/ ');
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: 'https://temporary.example.test:8443/api/:path*' },
    { source: '/rtc/:path+', destination: 'https://temporary.example.test:8443/rtc/:path+' },
    { source: '/healthz', destination: 'https://temporary.example.test:8443/healthz' },
  ]);
  assert.deepEqual(config.headers.map((route: { source: string }) => route.source), ['/api/:path*', '/rtc/:path*', '/healthz']);
  for (const route of config.headers) {
    assert.deepEqual(route.headers, [
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'x-vercel-enable-rewrite-caching', value: '0' },
    ]);
  }
  assert.deepEqual(config.env, {}, 'The routing origin must not be injected through Next browser environment configuration.');
});

test('frontend fails closed on backend credentials, paths and insecure or malformed origins', async () => {
  for (const origin of ['http://temporary.example.test', 'https://user:secret@temporary.example.test', 'https://temporary.example.test/api', 'https://temporary.example.test/?query=1', 'https://temporary.example.test/#fragment', '//temporary.example.test', 'not-a-url']) {
    const result = await readProxyConfig(origin);
    assert.notEqual(result.status, 0, `Unexpectedly accepted invalid backend origin category: ${origin.startsWith('https://user:') ? 'credentials' : origin}`);
    assert.equal(result.stdout, '');
  }
});

test('remote routing requires a server-only secret and accepts only the intended backend paths', () => {
  for (const secret of [undefined, '', 'short', 'x'.repeat(257), 'x'.repeat(32) + '\n', 'x'.repeat(32) + ' ']) {
    assert.throws(() => backendProxyConfig({ BACKEND_ORIGIN: 'https://temporary.example.test', BACKEND_PROXY_SECRET: secret }), /BACKEND_PROXY_SECRET/);
  }
  assert.equal(backendProxyConfig({ BACKEND_ORIGIN: '', BACKEND_PROXY_SECRET: 'unused' }), undefined);
  for (const path of ['/api', '/api/auth/discord', '/api/events', '/rtc', '/rtc/validate', '/healthz']) assert.equal(isBackendPath(path), true);
  for (const path of ['/', '/room', '/api-other', '/rtc-other', '/healthz/extra', '//temporary.example.test/api']) assert.equal(isBackendPath(path), false);
});

test('backend proxy replaces caller origin credentials while retaining session and WebSocket upgrade headers', () => {
  const previousOrigin = process.env.BACKEND_ORIGIN;
  const previousSecret = process.env.BACKEND_PROXY_SECRET;
  process.env.BACKEND_ORIGIN = 'https://temporary.example.test';
  process.env.BACKEND_PROXY_SECRET = fixtureSecret;
  try {
    const response = proxy(new NextRequest('https://app.example.test/rtc?access_token=fixture', { headers: {
      'x-stage-proxy': 'caller-controlled', 'x-pinggy-no-screen': 'caller-controlled',
      cookie: 'session=fixture', origin: 'https://app.example.test', upgrade: 'websocket', connection: 'Upgrade',
    } }));
    assert.equal(response.headers.get('x-middleware-request-x-stage-proxy'), fixtureSecret);
    assert.equal(response.headers.get('x-middleware-request-x-pinggy-no-screen'), '1');
    assert.equal(response.headers.get('x-middleware-request-cookie'), 'session=fixture');
    assert.equal(response.headers.get('x-middleware-request-origin'), 'https://app.example.test');
    assert.equal(response.headers.get('x-middleware-request-upgrade'), 'websocket');
    assert.equal(response.headers.get('x-middleware-request-connection'), 'Upgrade');
    assert.equal(response.headers.get('x-stage-proxy'), null);
    assert.equal(response.headers.get('x-pinggy-no-screen'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-vercel-enable-rewrite-caching'), '0');
    assert.equal(response.headers.get('content-security-policy'), null, 'API and media requests do not render HTML.');
  } finally {
    if (previousOrigin === undefined) delete process.env.BACKEND_ORIGIN; else process.env.BACKEND_ORIGIN = previousOrigin;
    if (previousSecret === undefined) delete process.env.BACKEND_PROXY_SECRET; else process.env.BACKEND_PROXY_SECRET = previousSecret;
  }
});

test('local desktop backend paths do not receive frontend proxy credentials or HTML policy', () => {
  const previous = process.env.BACKEND_ORIGIN;
  delete process.env.BACKEND_ORIGIN;
  try {
    const response = proxy(new NextRequest('http://localhost:3210/api/me'));
    assert.equal(response.headers.get('x-middleware-next'), '1');
    assert.equal(response.headers.get('x-middleware-request-x-stage-proxy'), null);
    assert.equal(response.headers.get('content-security-policy'), null);
  } finally { if (previous === undefined) delete process.env.BACKEND_ORIGIN; else process.env.BACKEND_ORIGIN = previous; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { createApp } from '../backend/src/app.ts';
import { loadConfig, projectRoot } from '../backend/src/config.ts';
import { MediaPolicyError } from '../backend/src/media/guard.ts';

const keys = { SESSION_KEY: 'a'.repeat(64), TOKEN_ENCRYPTION_KEY: 'b'.repeat(64) };
interface RequestOptions {
  origin?: string | null;
  host?: string;
  headers?: Record<string, string | undefined>;
  payload?: InjectOptions['payload'];
  cookies?: boolean;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'stage-split-hosting-'));
  const config = loadConfig({ ...keys, NODE_ENV: 'test', LOCAL_PREVIEW: 'true', HOST: '127.0.0.1',
    APP_URL: 'http://127.0.0.1:3210', FRONTEND_URL: 'http://localhost:3211', DATA_DIR: directory,
    LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:9', LIVEKIT_API_KEY: 'split-fixture', LIVEKIT_API_SECRET: 'c'.repeat(64) });
  const bundle = await createApp(config, { disableFrontend: true, quiet: true,
    fetch: async () => { throw new Error('Real provider access is disabled in this fixture.'); } });
  // Media provisioning is outside this HTTP/authorization fixture. Token
  // creation and gateway authorization still use their installed implementations.
  bundle.media.ensureRoom = async () => undefined;
  bundle.media.reconcile = async () => undefined;
  bundle.media.closeRoom = async () => undefined;
  bundle.media.remove = async () => undefined;
  const jar = new Map<string, string>();
  const request = async (method: 'GET' | 'POST' | 'OPTIONS', url: string, options: RequestOptions = {}): Promise<LightMyRequestResponse> => {
    const origin = options.origin === undefined ? config.frontendOrigin : options.origin;
    const response = await bundle.app.inject({ method, url,
      headers: { host: options.host ?? new URL(config.APP_URL).host, ...(origin === null ? {} : { origin }), ...options.headers },
      cookies: options.cookies === false ? {} : Object.fromEntries(jar), payload: options.payload });
    for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
    return response;
  };
  const login = async () => {
    assert.equal((await request('GET', '/api/bootstrap')).statusCode, 200);
    assert.equal((await request('POST', '/api/dev/login', { payload: { persona: 'owner' } })).statusCode, 200);
  };
  return { ...bundle, config, request, login, cookie: () => [...jar].map(([name, value]) => name + '=' + encodeURIComponent(value)).join('; '),
    cleanup: async () => { await bundle.app.close(); assert.ok(directory.startsWith(join(tmpdir(), 'stage-split-hosting-'))); rmSync(directory, { recursive: true, force: true }); } };
}

test('split configuration keeps backend callback/media origin separate from the frontend and requires production HTTPS', () => {
  const config = loadConfig({ ...keys, APP_URL: 'https://api.example.test', FRONTEND_URL: 'https://app.example.test', DATA_DIR: './data' });
  assert.equal(config.origin, 'https://api.example.test');
  assert.equal(config.frontendOrigin, 'https://app.example.test');
  assert.equal(config.cookieSecure, true);
  assert.equal(config.dataDir, resolve(projectRoot, 'data'), 'Workspace commands must not silently select a second data directory.');
  assert.equal(loadConfig({ ...keys, APP_URL: 'https://api.example.test' }).frontendOrigin, 'https://api.example.test');
  assert.equal(loadConfig({ ...keys, APP_URL: 'https://api.example.test', FRONTEND_URL: '' }).frontendOrigin, 'https://api.example.test');
  assert.throws(() => loadConfig({ ...keys, NODE_ENV: 'production', APP_URL: 'https://api.example.test', FRONTEND_URL: 'http://app.example.test' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...keys, LOCAL_PREVIEW: 'true', FRONTEND_URL: 'https://app.example.test' }), /loopback/);
});

test('only the configured frontend receives credentialed API CORS and allowed preflight responses', async () => {
  const f = await fixture();
  try {
    const response = await f.request('OPTIONS', '/api/commands', { headers: {
      'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-requested-with, x-csrf-token' } });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], f.config.frontendOrigin);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(String(response.headers.vary), /Origin/i);
    assert.match(String(response.headers['access-control-allow-methods']), /POST/);
    assert.match(String(response.headers['access-control-allow-headers']), /x-csrf-token/i);
    const boot = await f.request('GET', '/api/bootstrap');
    assert.equal(boot.headers['access-control-allow-origin'], f.config.frontendOrigin);
    assert.equal(boot.headers['access-control-allow-credentials'], 'true');
    assert.match(String(boot.headers['cache-control']), /no-store/);
    assert.equal(boot.headers['access-control-allow-origin'] === '*', false);
  } finally { await f.cleanup(); }
});

test('local API quota responses preserve credentialed frontend CORS and expose the retry deadline', async context => {
  const f = await fixture();
  try {
    // The installed global limiter allows 180 anonymous requests per minute.
    // A device cookie is retained, but this fixture never signs in or gets a SID.
    for (let count = 0; count < 180; count++) {
      assert.equal((await f.request('GET', '/api/bootstrap')).statusCode, 200);
    }
    const limited = await f.request('GET', '/api/bootstrap');
    assert.equal(limited.statusCode, 429, 'The real plugin quota must reject request 181.');
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(Number.isFinite(retryAfter) && retryAfter > 0);
    context.diagnostic(JSON.stringify({ status: limited.statusCode, retryAfter,
      allowOrigin: limited.headers['access-control-allow-origin'] ?? null,
      credentials: limited.headers['access-control-allow-credentials'] ?? null,
      exposed: limited.headers['access-control-expose-headers'] ?? null }));
    assert.equal(limited.headers['access-control-allow-origin'], f.config.frontendOrigin);
    assert.equal(limited.headers['access-control-allow-credentials'], 'true');
    assert.match(String(limited.headers['access-control-expose-headers']), /(?:^|[,\s])retry-after(?:$|[,\s])/i);
    assert.match(String(limited.headers.vary), /Origin/i);
    assert.equal(limited.json().error, 'rate-limited');
    assert.equal(limited.json().retryAfterSeconds, Math.ceil(retryAfter));
    assert.match(limited.json().message, /rate|retry|requests/i);
    const foreign = await f.request('GET', '/api/bootstrap', { origin: 'https://untrusted.example' });
    assert.equal(foreign.statusCode, 403, 'The frontend Origin gate still rejects an untrusted site.');
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    assert.equal(foreign.headers['access-control-allow-credentials'], undefined);
    const wrongHost = await f.request('GET', '/api/bootstrap', { host: 'untrusted.example' });
    assert.equal(wrongHost.statusCode, 403);
    assert.equal(wrongHost.headers['access-control-allow-origin'], undefined);
  } finally { await f.cleanup(); }
});

test('untrusted origins, unsupported preflight capabilities and unrecognized backend hosts cannot gain API access', async () => {
  const f = await fixture();
  try {
    for (const options of [
      { origin: 'https://untrusted.example', headers: { 'access-control-request-method': 'POST' } },
      { origin: null, headers: { 'access-control-request-method': 'POST' } },
      { headers: { 'access-control-request-method': 'DELETE' } },
      { headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-unrecognized-capability' } },
    ]) {
      const response = await f.request('OPTIONS', '/api/commands', options);
      assert.equal(response.statusCode, 403);
      assert.equal(response.headers['access-control-allow-methods'], undefined);
    }
    const originRejected = await f.request('GET', '/api/bootstrap', { origin: 'https://untrusted.example' });
    assert.equal(originRejected.statusCode, 403);
    assert.equal(originRejected.headers['access-control-allow-origin'], undefined);
    assert.equal((await f.request('GET', '/api/bootstrap', { host: 'untrusted.example' })).statusCode, 403);
  } finally { await f.cleanup(); }
});

test('credentialed frontend commands retain device admission while missing or foreign origins cannot mutate the room', async () => {
  const f = await fixture();
  try {
    await f.login();
    for (const origin of [null, 'https://untrusted.example']) {
      const rejected = await f.request('POST', '/api/commands', { origin, payload: { type: 'session.open', title: 'Rejected', mode: 'open' } });
      assert.equal(rejected.statusCode, 403);
    }
    assert.equal((await f.request('GET', '/api/state')).json().session, null);
    const opened = await f.request('POST', '/api/commands', { payload: { type: 'session.open', title: 'Split-host fixture', mode: 'open' } });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().snapshot.session.title, 'Split-host fixture');
    const state = await f.request('GET', '/api/state');
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().self.admission.id, opened.json().snapshot.self.admission.id);
    const withoutCookie = await f.request('GET', '/api/state', { cookies: false });
    assert.equal(withoutCookie.statusCode, 401, 'CORS permission never substitutes for the authenticated cookie.');
  } finally { await f.cleanup(); }
});

test('media credentials point at the backend gateway and cross-origin signaling still requires the exact frontend and session cookie', async () => {
  const f = await fixture();
  try {
    await f.login();
    assert.equal((await f.request('POST', '/api/commands', { payload: { type: 'session.open', title: 'Gateway boundary', mode: 'open' } })).statusCode, 200);
    const response = await f.request('POST', '/api/media/token', { payload: {} });
    assert.equal(response.statusCode, 200);
    const credentials = response.json();
    assert.equal(credentials.serverUrl, 'ws://127.0.0.1:3210');
    const request = (origin: string | null, cookie = f.cookie()) => ({
      url: '/rtc?access_token=' + encodeURIComponent(credentials.token),
      headers: { upgrade: 'websocket', cookie, ...(origin === null ? {} : { origin }) },
    }) as IncomingMessage;
    assert.equal((await f.media.validate(request(f.config.frontendOrigin))).active, true);
    for (const value of [request('https://untrusted.example'), request(null), request(f.config.frontendOrigin, '')]) {
      await assert.rejects(f.media.validate(value), error => error instanceof MediaPolicyError && error.code === 'admission_revoked');
    }
    assert.equal(f.media.guard.snapshot().length, 0, 'Authorization checks must not create media publications.');
  } finally { await f.cleanup(); }
});

test('live events preserve credentialed CORS headers after the response is hijacked', async () => {
  const f = await fixture();
  const cancellation = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await f.login();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(address + '/api/events', {
      headers: { origin: f.config.frontendOrigin, cookie: f.cookie() }, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(3000)]),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), f.config.frontendOrigin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: invalidate/);
  } finally {
    cancellation.abort();
    await reader?.cancel().catch(() => undefined);
    await f.cleanup();
  }
});

test('Discord OAuth stays on the backend and failed callbacks return to the configured frontend without a provider request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stage-split-hosting-'));
  let providerCalls = 0;
  const config = loadConfig({ ...keys, NODE_ENV: 'test', APP_URL: 'https://api.example.test', FRONTEND_URL: 'https://app.example.test', DATA_DIR: directory,
    DISCORD_CLIENT_ID: '111111111111111111', DISCORD_CLIENT_SECRET: 'fixture-only', DISCORD_GUILD_ID: '222222222222222222', DISCORD_OWNER_ID: '333333333333333333' });
  const bundle = await createApp(config, { disableFrontend: true, quiet: true,
    fetch: async () => { providerCalls++; throw new Error('Provider requests are disabled.'); } });
  try {
    const begin = await bundle.app.inject({ method: 'GET', url: '/api/auth/discord', headers: { host: 'api.example.test' } });
    assert.equal(begin.statusCode, 302);
    const redirect = new URL(String(begin.headers.location));
    assert.equal(redirect.searchParams.get('redirect_uri'), 'https://api.example.test/api/auth/discord/callback');
    const cookie = begin.cookies.map(value => value.name + '=' + encodeURIComponent(value.value)).join('; ');
    assert.match(String(begin.headers['set-cookie']), /HttpOnly/i);
    assert.match(String(begin.headers['set-cookie']), /Secure/i);
    assert.doesNotMatch(String(begin.headers['set-cookie']), /;\s*Domain=/i, 'Backend cookies remain host-only.');
    const failed = await bundle.app.inject({ method: 'GET', url: '/api/auth/discord/callback?state=invalid&code=fixture-code', headers: { host: 'api.example.test', cookie } });
    assert.equal(failed.statusCode, 302);
    assert.match(String(failed.headers.location), /^https:\/\/app\.example\.test\/\?authError=/);
    assert.equal(providerCalls, 0);
  } finally {
    await bundle.app.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'stage-split-hosting-')));
    rmSync(directory, { recursive: true, force: true });
  }
});

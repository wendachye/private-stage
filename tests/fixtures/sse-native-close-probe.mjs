// Explicit diagnostic only, outside npm test. No emitted/fabricated close events.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../../backend/src/app.ts';
import { loadConfig } from '../../backend/src/config.ts';

const bounded = async (promise, milliseconds) => {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
const results = [];
for (const mode of ['fetch', 'fetch-browser-headers', 'http-empty-get']) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-sse-native-probe-'));
  const config = loadConfig({ SESSION_KEY: 'a'.repeat(64), TOKEN_ENCRYPTION_KEY: 'b'.repeat(64), LOCAL_PREVIEW: 'true', NODE_ENV: 'test', DATA_DIR: dir,
    APP_URL: 'http://127.0.0.1:3210', FRONTEND_URL: 'http://localhost:3211' });
  const { app } = await createApp(config, { disableFrontend: true, quiet: true });
  const jar = {};
  for (const response of [await app.inject({ method: 'GET', url: '/api/bootstrap' })]) for (const cookie of response.cookies) jar[cookie.name] = cookie.value;
  const login = await app.inject({ method: 'POST', url: '/api/dev/login', headers: { origin: config.frontendOrigin }, cookies: jar, payload: { persona: 'owner' } });
  for (const cookie of login.cookies) jar[cookie.name] = cookie.value;
  const wireCookie = Object.entries(jar).map(([name, value]) => name + '=' + encodeURIComponent(value)).join('; ');
  const events = [];
  let observedRequest, observedResponse, closePromise, cancel;
  app.server.on('request', (request, response) => {
    if (request.url !== '/api/events') return;
    observedRequest = request; observedResponse = response;
    request.on('end', () => events.push('request.end'));
    request.on('close', () => events.push('request.close'));
    response.on('finish', () => events.push('response.finish'));
    response.on('close', () => events.push('response.close'));
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { origin: config.frontendOrigin, cookie: wireCookie,
      ...(mode === 'fetch-browser-headers' ? { accept: 'text/event-stream', 'cache-control': 'no-cache', 'sec-fetch-mode': 'cors' } : {}) };
    if (mode === 'http-empty-get') {
      await new Promise((resolve, reject) => {
        const client = httpRequest(address + '/api/events', { method: 'GET', headers: { ...headers, 'content-length': '0' } }, response => {
          cancel = () => { response.destroy(); client.destroy(); };
          if (response.statusCode !== 200) { reject(new Error('Isolated authentication failed.')); return; }
          response.once('data', () => resolve());
          response.once('error', reject);
        });
        client.setTimeout(5000, () => client.destroy(new Error('Isolated HTTP stream timed out.')));
        client.once('error', reject); client.end();
      });
    } else {
      const abort = new AbortController();
      const response = await fetch(address + '/api/events', { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
      if (response.status !== 200) throw new Error('Isolated authentication failed.');
      const reader = response.body.getReader();
      cancel = async () => { abort.abort(); await reader.cancel().catch(() => {}); };
      await reader.read();
    }
    await fetch(address + '/healthz', { signal: AbortSignal.timeout(5000) }).then(response => response.json());
    // Let native completion/close callbacks run, without consuming the request
    // or emitting events. An independent request/response has already finished.
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = { events: [...events], requestComplete: observedRequest?.complete, requestReadableEnded: observedRequest?.readableEnded,
      requestDestroyed: observedRequest?.destroyed, responseEnded: observedResponse?.writableEnded, socketDestroyed: observedResponse?.socket?.destroyed };
    closePromise = app.close();
    const graceful = await bounded(closePromise, 1500);
    results.push({ mode, before, gracefulCloseWithin1500ms: graceful, afterEvents: [...events] });
  } finally {
    await cancel?.();
    closePromise ??= app.close();
    if (!await bounded(closePromise, 1000)) { app.server.closeAllConnections(); await bounded(closePromise, 1000); }
    if (!dir.startsWith(join(tmpdir(), 'stage-sse-native-probe-'))) throw new Error('Unexpected scratch path.');
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), fabricatedEvents: false, actualAppTouched: false, results }, null, 2));

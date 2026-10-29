import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('compiled backend starts API-only from its own project folder and drains through owned IPC shutdown', {
  skip: process.env.RUN_PRODUCTION_CHECK !== '1' ? 'Set RUN_PRODUCTION_CHECK=1 after npm run build.' : false,
}, async () => {
  const backend = resolve('backend');
  const entry = join(backend, 'dist/index.js');
  assert.ok(existsSync(entry), 'The standalone backend package must be built before acceptance.');
  const data = mkdtempSync(join(tmpdir(), 'stage-backend-package-'));
  const probe = createServer();
  await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  assert.ok(port >= 1024 && ![3210, 3211].includes(port));
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  const child = fork(entry, ['--api-only'], {
    cwd: backend, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', LOCAL_PREVIEW: 'true', HOST: '127.0.0.1', PORT: String(port),
      APP_URL: `http://127.0.0.1:${port}`, FRONTEND_URL: '', DATA_DIR: data,
      SESSION_KEY: 'd'.repeat(64), TOKEN_ENCRYPTION_KEY: 'e'.repeat(64),
      DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_GUILD_ID: '', DISCORD_OWNER_ID: '', DISCORD_ADMIN_ROLE_IDS: '',
      LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:9', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
    },
  });
  let output = '';
  child.stdout!.on('data', bytes => output += String(bytes));
  child.stderr!.on('data', bytes => output += String(bytes));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
  const within = async <T>(promise: Promise<T>, milliseconds: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<null>(done => { timer = setTimeout(() => done(null), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Compiled backend exited before readiness: ' + output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { assert.deepEqual(await response.json(), { ok: true, service: 'private-stage', preview: true }); ready = true; break; }
      } catch {}
      await new Promise(done => setTimeout(done, 50));
    }
    assert.equal(ready, true, 'The compiled API-only backend did not become ready.');
    const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(2000) });
    assert.equal(bootstrap.status, 200);
    const boot = await bootstrap.json();
    assert.equal(boot.localPreview, true);
    assert.equal(boot.configuration.discordConfigured, false);
    assert.equal(boot.configuration.mediaConfigured, false);
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(page.status, 404, 'Standalone backend start must not also start the frontend.');
    assert.match(page.headers.get('content-type') ?? '', /application\/json/);
    await page.arrayBuffer();
    child.send({ type: 'private-stage:shutdown' });
    const stopped = await within(exited, 3000);
    assert.ok(stopped, 'Compiled backend did not drain through its IPC shutdown contract.');
    assert.deepEqual(stopped, { code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'private-stage:shutdown' }, () => undefined);
      if (!await within(exited, 1500)) { child.kill(); await within(exited, 1500); }
    }
    assert.ok(data.startsWith(join(tmpdir(), 'stage-backend-package-')));
    rmSync(data, { recursive: true, force: true });
  }
});

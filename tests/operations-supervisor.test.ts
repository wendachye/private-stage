import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { RotatingLog, runSupervisor } from '../scripts/runtime-supervisor.mjs';

function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'private-stage-supervisor-'));
  const entry = join(root, 'fixture.mjs');
  writeFileSync(entry, source);
  return { root, entry, dataDir: join(root, 'data') };
}
function clean(root: string) {
  assert.ok(root.startsWith(join(tmpdir(), 'private-stage-supervisor-')));
  rmSync(root, { recursive: true, force: true });
}
async function waitFor(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) await sleep(10);
  assert.ok(existsSync(path), `Fixture did not create ${path}`);
}

test('bounded logs rotate oversized chunks without exceeding per-file or retained-file limits', () => {
  const f = fixture('');
  try {
    const path = join(f.root, 'logs/app.log');
    const log = new RotatingLog(path, { maxBytes: 32, fileCount: 3 });
    log.write(Buffer.from(Array.from({ length: 200 }, (_, index) => index)));
    log.close();
    const files = readdirSync(join(f.root, 'logs'));
    assert.equal(files.length, 3);
    for (const file of files) assert.ok(statSync(join(f.root, 'logs', file)).size <= 32);
    const retained = Buffer.concat([readFileSync(`${path}.2`), readFileSync(`${path}.1`), readFileSync(path)]);
    assert.deepEqual(retained, Buffer.from(Array.from({ length: 72 }, (_, index) => index + 128)));
    const reopened = new RotatingLog(path, { maxBytes: 32, fileCount: 3 });
    reopened.write('continued'); reopened.close();
    assert.ok(readFileSync(path).includes(Buffer.from('continued')));
  } finally { clean(f.root); }
});

test('supervisor captures stdout/stderr and leaves a clean application exit stopped', { timeout: 8000 }, async () => {
  const f = fixture(`console.log('fictional stdout'); console.error('fictional stderr');`);
  try {
    const code = await runSupervisor({ ...f, execArgv: [], restartDelays: [10, 20, 30] });
    assert.equal(code, 0);
    assert.match(readFileSync(join(f.root, 'logs/app.log'), 'utf8'), /fictional stdout/);
    assert.match(readFileSync(join(f.root, 'logs/app.error.log'), 'utf8'), /fictional stderr/);
    const state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
    assert.equal(state.status, 'exited'); assert.equal(state.restarts, 0);
    assert.equal(existsSync(join(f.dataDir, 'supervisor.lock')), false);
    assert.equal(existsSync(join(f.dataDir, 'app.pid')), false);
  } finally { clean(f.root); }
});

test('supervisor caps unexpected-exit retries and never loops indefinitely', { timeout: 8000 }, async () => {
  const f = fixture(`import{appendFileSync}from'node:fs';appendFileSync('attempts.txt','attempt\\n');process.exit(2);`);
  try {
    const code = await runSupervisor({ ...f, execArgv: [], restartDelays: [10, 20, 30] });
    assert.equal(code, 1);
    assert.equal(readFileSync(join(f.root, 'attempts.txt'), 'utf8').trim().split('\n').length, 4);
    const state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
    assert.equal(state.status, 'failed'); assert.equal(state.restarts, 3);
    assert.equal(existsSync(join(f.dataDir, 'supervisor.lock')), false);
    assert.match(readFileSync(join(f.root, 'logs/app.error.log'), 'utf8'), /Crash restart limit reached/);
  } finally { clean(f.root); }
});

test('owned stop request drains a child through IPC without restarting; duplicate supervisor and wrong token are refused', { timeout: 8000 }, async () => {
  const f = fixture(`import{writeFileSync}from'node:fs';process.on('message',m=>{if(m?.type==='private-stage:shutdown'){writeFileSync('graceful.txt','drained');process.exit(0)}});writeFileSync('ready.txt','ready');`);
  let pending: Promise<number> | undefined;
  try {
    pending = runSupervisor({ ...f, execArgv: [], restartDelays: [10, 20, 30], shutdownTimeoutMs: 1000 });
    await waitFor(join(f.root, 'ready.txt'));
    await assert.rejects(runSupervisor({ ...f, execArgv: [] }), /already running/);
    writeFileSync(join(f.dataDir, 'supervisor.stop'), JSON.stringify({ token: 'unowned-token' }));
    await sleep(200);
    assert.equal(existsSync(join(f.root, 'graceful.txt')), false);
    const state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
    writeFileSync(join(f.dataDir, 'supervisor.stop'), JSON.stringify({ token: state.token }));
    assert.equal(await pending, 0); pending = undefined;
    assert.equal(readFileSync(join(f.root, 'graceful.txt'), 'utf8'), 'drained');
    const stopped = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.restarts, 0);
    assert.equal(existsSync(join(f.dataDir, 'supervisor.lock')), false);
    assert.equal(existsSync(join(f.dataDir, 'supervisor.stop')), false);
  } finally {
    if (pending) {
      const state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
      writeFileSync(join(f.dataDir, 'supervisor.stop'), JSON.stringify({ token: state.token }));
      await pending;
    }
    clean(f.root);
  }
});

test('stop during crash backoff prevents the scheduled restart and recovers a dead supervisor lock', { timeout: 8000 }, async () => {
  const f = fixture(`import{appendFileSync}from'node:fs';appendFileSync('attempts.txt','attempt\\n');process.exit(2);`);
  let pending: Promise<number> | undefined;
  try {
    mkdirSync(f.dataDir);
    writeFileSync(join(f.dataDir, 'supervisor.lock'), JSON.stringify({ pid: 2147483647, token: 'dead-fixture-supervisor' }));
    pending = runSupervisor({ ...f, execArgv: [], restartDelays: [2000] });
    const deadline = Date.now() + 5000;
    let state: { status: string; token: string } | undefined;
    while (Date.now() < deadline) {
      state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
      if (state!.status === 'backoff') break;
      await sleep(10);
    }
    assert.equal(state!.status, 'backoff');
    writeFileSync(join(f.dataDir, 'supervisor.stop'), JSON.stringify({ token: state!.token }));
    assert.equal(await pending, 0); pending = undefined;
    assert.equal(readFileSync(join(f.root, 'attempts.txt'), 'utf8').trim().split('\n').length, 1);
    assert.equal(existsSync(join(f.dataDir, 'supervisor.lock')), false);
  } finally {
    if (pending) {
      const state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
      writeFileSync(join(f.dataDir, 'supervisor.stop'), JSON.stringify({ token: state.token }));
      await pending;
    }
    clean(f.root);
  }
});

test('unresponsive child is terminated after the bounded shutdown deadline and reported as failed', { timeout: 8000 }, async () => {
  const f = fixture(`import{writeFileSync}from'node:fs';process.on('message',()=>{});writeFileSync('ready.txt','ready');`);
  let pending: Promise<number> | undefined;
  try {
    pending = runSupervisor({ ...f, execArgv: [], shutdownTimeoutMs: 100 });
    await waitFor(join(f.root, 'ready.txt'));
    const state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
    writeFileSync(join(f.dataDir, 'supervisor.stop'), JSON.stringify({ token: state.token }));
    assert.equal(await pending, 1); pending = undefined;
    const failed = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
    assert.equal(failed.status, 'failed'); assert.equal(failed.restarts, 0);
    assert.equal(existsSync(join(f.dataDir, 'app.pid')), false);
    assert.match(readFileSync(join(f.root, 'logs/app.error.log'), 'utf8'), /Graceful shutdown timed out/);
  } finally {
    if (pending) {
      const state = JSON.parse(readFileSync(join(f.dataDir, 'supervisor.json'), 'utf8'));
      writeFileSync(join(f.dataDir, 'supervisor.stop'), JSON.stringify({ token: state.token }));
      await pending;
    }
    clean(f.root);
  }
});

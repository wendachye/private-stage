import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(project, '../../work/operations-check');
const windows = process.platform === 'win32';
const windowsTest = windows ? test : test.skip;

// Every script runs against copied files and synthetic keys below work/operations-check.
// Fixtures intentionally remain available for inspection. No application service is launched.
function fixture(port: number, dataSetting = './data') {
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'fixture-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'deploy'));
  mkdirSync(join(root, 'logs'));
  mkdirSync(join(root, 'node_modules'));
  const data = resolve(root, dataSetting);
  mkdirSync(data, { recursive: true });
  for (const name of ['Common.ps1', 'Private-Storage.ps1', 'Backup-Local.ps1', 'Restore-Local.ps1', 'Start-Local.ps1', 'Stop-Local.ps1']) {
    copyFileSync(join(project, 'scripts', name), join(root, 'scripts', name));
  }
  const env = (setting: string | null = dataSetting) => [
    `PORT=${port}`, `APP_URL=http://127.0.0.1:${port}`,
    ...(setting === null ? [] : [`DATA_DIR=${setting}`]),
    'FIXTURE_SECRET=synthetic-test-only', '',
  ].join('\n');
  writeFileSync(join(root, '.env'), env());
  writeFileSync(join(root, 'deploy/livekit.local.yaml'), 'fixture: synthetic-test-only\n');
  return { root, data, env };
}

const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
function run(root: string, script: string, args = '', prefix = '') {
  return new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `$ErrorActionPreference='Stop'; ${prefix}; & ${ps(join(root, 'scripts', script))} ${args}`],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Isolated script timeout: ${script}\n${output}`)); }, 20000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => { clearTimeout(timeout); resolveResult({ code, output }); });
  });
}

function setDatabase(path: string, value: string) {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS fixture (value TEXT NOT NULL); DELETE FROM fixture;');
    database.prepare('INSERT INTO fixture (value) VALUES (?)').run(value);
  } finally { database.close(); }
}

async function listen(health = false) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ service: health ? 'private-stage' : 'unrelated-fixture', fixture: true }));
  });
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}
const close = (server: Server) => new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
async function unusedPort() { const listener = await listen(); await close(listener.server); return listener.port; }
const backupNames = (root: string) => existsSync(join(root, 'backups')) ? readdirSync(join(root, 'backups')) : [];

windowsTest('Windows restore replaces SQLite data and preserves both prebackup and rollback without merging stale WAL/SHM', async (t) => {
  const f = fixture(await unusedPort());
  t.diagnostic(f.root);
  const databasePath = join(f.data, 'stage.sqlite');
  setDatabase(databasePath, 'original-backup');
  writeFileSync(join(f.data, 'app.pid'), '2147483647');
  writeFileSync(join(f.data, 'app.lock'), JSON.stringify({ pid: 2147483647, token: 'stale-fixture' }));
  writeFileSync(join(f.data, 'supervisor.lock'), JSON.stringify({ pid: 2147483647, token: 'stale-supervisor' }));
  writeFileSync(join(f.data, 'supervisor.json'), JSON.stringify({ pid: 2147483647, token: 'stale-supervisor', status: 'failed' }));
  writeFileSync(join(f.data, 'supervisor.stop'), JSON.stringify({ token: 'stale-supervisor' }));
  const backup = await run(f.root, 'Backup-Local.ps1');
  assert.equal(backup.code, 0, backup.output);
  const selected = backup.output.match(/Backup saved: ([^\r\n]+)/)?.[1];
  assert.ok(selected, backup.output);
  assert.equal(existsSync(join(selected, 'data/app.pid')), false);
  assert.equal(existsSync(join(selected, 'data/app.lock')), false);
  for (const name of ['supervisor.lock', 'supervisor.json', 'supervisor.stop']) assert.equal(existsSync(join(selected, 'data', name)), false);
  assert.equal(readFileSync(join(selected, '.env'), 'utf8'), f.env());
  assert.equal(readFileSync(join(selected, 'deploy/livekit.local.yaml'), 'utf8'), 'fixture: synthetic-test-only\n');
  // An older or manually assembled backup must not restore process-control state.
  for (const name of ['supervisor.lock', 'supervisor.json', 'supervisor.stop']) writeFileSync(join(selected, 'data', name), 'legacy-process-control');
  setDatabase(databasePath, 'newer-current-data');
  const currentDatabase = readFileSync(databasePath);
  writeFileSync(join(f.data, 'stage.sqlite-wal'), 'newer-stale-wal-fixture');
  writeFileSync(join(f.data, 'stage.sqlite-shm'), 'newer-stale-shm-fixture');
  writeFileSync(join(f.data, 'current-only.txt'), 'preserve-in-rollback-only');
  const before = new Set(backupNames(f.root));
  const restored = await run(f.root, 'Restore-Local.ps1', `-BackupPath ${ps(selected)} -Confirm:$false`);
  assert.equal(restored.code, 0, restored.output);
  assert.equal(existsSync(join(f.data, 'stage.sqlite-wal')), false);
  assert.equal(existsSync(join(f.data, 'stage.sqlite-shm')), false);
  assert.equal(existsSync(join(f.data, 'current-only.txt')), false);
  assert.equal(existsSync(join(f.data, 'app.pid')), false);
  assert.equal(existsSync(join(f.data, 'app.lock')), false);
  for (const name of ['supervisor.lock', 'supervisor.json', 'supervisor.stop']) assert.equal(existsSync(join(f.data, name)), false);
  const database = new DatabaseSync(databasePath);
  try { assert.equal(database.prepare('SELECT value FROM fixture').get()?.value, 'original-backup'); }
  finally { database.close(); }
  const created = backupNames(f.root).filter((name) => !before.has(name));
  const rollback = created.find((name) => name.startsWith('pre-restore-'));
  const prebackup = created.find((name) => !name.startsWith('pre-restore-'));
  assert.ok(rollback, restored.output); assert.ok(prebackup, restored.output);
  for (const retained of [rollback, prebackup]) {
    const retainedData = join(f.root, 'backups', retained, 'data');
    assert.deepEqual(readFileSync(join(retainedData, 'stage.sqlite')), currentDatabase);
    assert.equal(readFileSync(join(retainedData, 'stage.sqlite-wal'), 'utf8'), 'newer-stale-wal-fixture');
    assert.equal(readFileSync(join(retainedData, 'stage.sqlite-shm'), 'utf8'), 'newer-stale-shm-fixture');
    assert.equal(readFileSync(join(retainedData, 'current-only.txt'), 'utf8'), 'preserve-in-rollback-only');
  }
});

windowsTest('Windows backup refuses a live PID, live startup lock, malformed lock, and unrelated listening port', async (t) => {
  for (const guard of ['pid', 'lock', 'supervisor-lock', 'malformed-lock', 'listener']) {
    const listener = guard === 'listener' ? await listen() : null;
    const f = fixture(listener?.port ?? await unusedPort());
    t.diagnostic(`${guard}: ${f.root}`);
    if (guard === 'pid') writeFileSync(join(f.data, 'app.pid'), String(process.pid));
    if (guard === 'lock') writeFileSync(join(f.data, 'app.lock'), JSON.stringify({ pid: process.pid, token: 'fixture-active' }));
    if (guard === 'supervisor-lock') writeFileSync(join(f.data, 'supervisor.lock'), JSON.stringify({ pid: process.pid, token: 'fixture-supervisor' }));
    if (guard === 'malformed-lock') writeFileSync(join(f.data, 'app.lock'), '{not-a-valid-lock');
    writeFileSync(join(f.data, 'untouched.txt'), 'live-data');
    try {
      const result = await run(f.root, 'Backup-Local.ps1');
      assert.notEqual(result.code, 0, `${guard} must refuse backup:\n${result.output}`);
      assert.equal(backupNames(f.root).length, 0);
      assert.equal(readFileSync(join(f.data, 'untouched.txt'), 'utf8'), 'live-data');
    } finally { if (listener) await close(listener.server); }
  }
});

windowsTest('Windows restore refuses effective DATA_DIR mismatch or ambiguous backup settings before changing files', async (t) => {
  for (const backupMapping of ['./other', null, 'duplicate']) {
    const f = fixture(await unusedPort(), './custom');
    t.diagnostic(`${backupMapping ?? 'omitted-default'}: ${f.root}`);
    const selected = join(f.root, 'selected-backup');
    mkdirSync(join(selected, 'data'), { recursive: true });
    writeFileSync(join(selected, 'data/untouched.txt'), 'backup-data');
    const selectedEnv = backupMapping === 'duplicate' ? f.env('./custom') + 'DATA_DIR=./data\n' : f.env(backupMapping);
    writeFileSync(join(selected, '.env'), selectedEnv);
    writeFileSync(join(f.data, 'untouched.txt'), 'current-data');
    const result = await run(f.root, 'Restore-Local.ps1', `-BackupPath ${ps(selected)} -Confirm:$false`);
    assert.notEqual(result.code, 0, `${backupMapping ?? 'omitted-default'} must refuse restore:\n${result.output}`);
    assert.equal(readFileSync(join(f.data, 'untouched.txt'), 'utf8'), 'current-data');
    assert.equal(readFileSync(join(f.root, '.env'), 'utf8'), f.env());
    assert.equal(backupNames(f.root).length, 0);
  }
});

windowsTest('Windows restore refuses a selected source nested within its current data directory', async (t) => {
  const f = fixture(await unusedPort());
  t.diagnostic(f.root);
  const selected = join(f.data, 'nested-backup');
  mkdirSync(join(selected, 'data'), { recursive: true });
  writeFileSync(join(selected, 'data/backup.txt'), 'selected-backup-data');
  writeFileSync(join(selected, '.env'), f.env());
  writeFileSync(join(f.data, 'untouched.txt'), 'current-data');
  const result = await run(f.root, 'Restore-Local.ps1', `-BackupPath ${ps(selected)} -Confirm:$false`);
  assert.notEqual(result.code, 0, result.output);
  assert.equal(readFileSync(join(f.data, 'untouched.txt'), 'utf8'), 'current-data');
  assert.equal(readFileSync(join(selected, 'data/backup.txt'), 'utf8'), 'selected-backup-data');
  assert.equal(backupNames(f.root).length, 0);
});

windowsTest('Windows backup refuses data nested under its backup output before any recursive copy', async (t) => {
  for (const setting of ['./backups', './backups/live']) {
    const f = fixture(await unusedPort(), setting);
    t.diagnostic(`${setting}: ${f.root}`);
    writeFileSync(join(f.data, 'untouched.txt'), 'current-data');
    const before = readdirSync(f.data).sort();
    const result = await run(f.root, 'Backup-Local.ps1');
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /backup directory/);
    assert.deepEqual(readdirSync(f.data).sort(), before);
    assert.equal(readFileSync(join(f.data, 'untouched.txt'), 'utf8'), 'current-data');
  }
});

windowsTest('Windows repeated start reuses a healthy fixture and refuses an occupied unrelated listener without starting app processes', async (t) => {
  for (const healthy of [true, false]) {
    const listener = await listen(healthy);
    const f = fixture(listener.port);
    t.diagnostic(`${healthy ? 'healthy' : 'unrelated'}: ${f.root}`);
    // Local function stubs prevent setup/Docker changes; fixture server is the only listener.
    const stubs = "function global:npm.cmd { $global:LASTEXITCODE=0 }; function global:docker { $global:LASTEXITCODE=0 }";
    try {
      const result = await run(f.root, 'Start-Local.ps1', '-NoBrowser', stubs);
      assert.equal(result.code, healthy ? 0 : 1, result.output);
      assert.match(result.output, healthy ? /Private Stage is running/ : /already in use/);
      assert.equal(existsSync(join(f.data, 'app.pid')), false);
      assert.equal(existsSync(join(f.data, 'app.lock')), false);
      assert.equal(readdirSync(join(f.root, 'logs')).length, 0);
    } finally { await close(listener.server); }
  }
});

windowsTest('Windows stop refuses unrelated saved supervisor and app process IDs before stopping anything', async (t) => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((ready, reject) => { unrelated.once('spawn', ready); unrelated.once('error', reject); });
  assert.ok(unrelated.pid);
  try {
    for (const record of ['supervisor', 'app']) {
      const f = fixture(await unusedPort());
      t.diagnostic(`${record}: ${f.root}`);
      if (record === 'supervisor') writeFileSync(join(f.data, 'supervisor.json'), JSON.stringify({ pid: unrelated.pid, token: 'unrelated-fixture' }));
      else writeFileSync(join(f.data, 'app.pid'), String(unrelated.pid));
      const result = await run(f.root, 'Stop-Local.ps1', '', "function global:docker { throw 'Docker must not be invoked for unrelated process ownership.' }");
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /belongs to another process/);
      assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    }
  } finally {
    const exited = new Promise<void>(ready => unrelated.once('exit', () => ready()));
    unrelated.kill(); await exited;
  }
});

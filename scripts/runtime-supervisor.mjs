import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class RotatingLog {
  constructor(path, { maxBytes = 10 * 1024 * 1024, fileCount = 3 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(fileCount) || fileCount < 1 || fileCount > 10) throw new Error('Invalid log bounds.');
    this.path = resolve(path); this.maxBytes = maxBytes; this.fileCount = fileCount;
    mkdirSync(dirname(this.path), { recursive: true });
    this.open();
    if (this.size >= this.maxBytes) this.rotate();
  }
  open() { this.fd = openSync(this.path, 'a'); this.size = statSync(this.path).size; }
  rotate() {
    closeSync(this.fd); this.fd = undefined;
    const oldest = this.fileCount === 1 ? this.path : `${this.path}.${this.fileCount - 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = this.fileCount - 2; index >= 0; index--) {
      const source = index === 0 ? this.path : `${this.path}.${index}`;
      if (existsSync(source)) renameSync(source, `${this.path}.${index + 1}`);
    }
    this.open();
  }
  write(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < buffer.length) {
      if (this.size >= this.maxBytes) this.rotate();
      const length = Math.min(buffer.length - offset, this.maxBytes - this.size);
      let written = 0;
      while (written < length) written += writeSync(this.fd, buffer, offset + written, length - written);
      this.size += length; offset += length;
    }
  }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}

const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));

function acquireLock(dataDir, token) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'supervisor.lock');
  const create = () => { const fd = openSync(path, 'wx'); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(fd); } };
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJSON(path);
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string') throw new Error('Supervisor lock is unreadable. Verify the old process is stopped before recovering it.');
    if (live(owner.pid)) throw new Error('A supervisor is already running for this data directory.');
    const recovery = `${path}.recover`;
    const fd = openSync(recovery, 'wx');
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      const current = readJSON(path);
      if (current.pid !== owner.pid || current.token !== owner.token || live(current.pid)) throw new Error('Supervisor ownership changed during recovery.');
      unlinkSync(path); create();
    } finally { closeSync(fd); unlinkSync(recovery); }
  }
  return () => { if (existsSync(path)) { const current = readJSON(path); if (current.pid === process.pid && current.token === token) unlinkSync(path); } };
}

// Process supervision only. A healthy process does not prove Discord/media readiness.
// Every restarted app executes its existing closed-room/media-reconciliation startup.
export async function runSupervisor({ root, dataDir, entry = join(root, 'backend/src/index.ts'), execArgv = ['--import', 'tsx'], env = process.env, logOptions = {}, restartDelays = [1000, 2000, 4000], shutdownTimeoutMs = 10000 }) {
  root = resolve(root); dataDir = resolve(dataDir); entry = resolve(entry);
  const token = randomUUID(), release = acquireLock(dataDir, token);
  const statePath = join(dataDir, 'supervisor.json'), stopPath = join(dataDir, 'supervisor.stop');
  const pidPath = join(dataDir, 'app.pid');
  let out, err, child, restartTimer, stopTimer, stopping = false, finished = false, restarts = 0;
  let childPid = null;
  const state = (status, exitCode = null) => writeFileSync(statePath, JSON.stringify({ pid: process.pid, token, childPid, entry, status, exitCode, restarts, updatedAt: new Date().toISOString() }));
  const log = text => err.write(`[supervisor] ${new Date().toISOString()} ${text}\n`);
  try { out = new RotatingLog(join(root, 'logs/app.log'), logOptions); err = new RotatingLog(join(root, 'logs/app.error.log'), logOptions); }
  catch (error) { out?.close(); release(); throw error; }
  return await new Promise((resolveExit, rejectExit) => {
    const finish = code => {
      if (finished) return; finished = true;
      clearInterval(poll); clearTimeout(restartTimer); clearTimeout(stopTimer);
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      try {
        state(stopping && code === 0 ? 'stopped' : code === 0 ? 'exited' : 'failed', code);
        if (existsSync(pidPath) && readFileSync(pidPath, 'utf8').trim() === String(childPid)) unlinkSync(pidPath);
        if (existsSync(stopPath)) { try { if (readJSON(stopPath).token === token) unlinkSync(stopPath); } catch { /* Unowned malformed control files are left for the operator. */ } }
        release(); out.close(); err.close(); resolveExit(code);
      } catch (error) { release(); out.close(); err.close(); rejectExit(error); }
    };
    const abort = () => {
      if (finished) return;
      stopping = true; clearTimeout(restartTimer); clearTimeout(stopTimer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      else finish(1);
    };
    const diagnostic = text => { try { log(text); } catch { abort(); } };
    const update = status => { try { state(status); return true; } catch { abort(); return false; } };
    const stop = () => {
      if (stopping || finished) return; stopping = true; clearTimeout(restartTimer);
      if (!update('stopping')) return;
      if (!child || child.exitCode !== null || child.signalCode !== null) { finish(0); return; }
      diagnostic('Stop requested; waiting for application shutdown.');
      if (child.connected) child.send({ type: 'private-stage:shutdown' }, error => { if (error && !finished) diagnostic('Application IPC unavailable; waiting for the bounded stop timeout.'); });
      stopTimer = setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) { diagnostic('Graceful shutdown timed out; terminating the owned application process.'); child.kill(); } }, shutdownTimeoutMs);
    };
    const launch = () => {
      if (stopping || finished) return;
      child = fork(entry, [], { cwd: root, execArgv, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      childPid = child.pid ?? null;
      const capture = sink => chunk => { try { sink.write(chunk); } catch { abort(); } };
      child.stdout.on('data', capture(out)); child.stderr.on('data', capture(err));
      child.once('error', error => { diagnostic(`Application launch failed (${error.code ?? 'spawn-error'}).`); });
      child.once('close', (code, signal) => {
        clearTimeout(stopTimer);
        if (stopping || code === 0) { finish(code === 0 ? 0 : 1); return; }
        if (restarts >= restartDelays.length) { diagnostic('Crash restart limit reached. Inspect logs and explicitly start again.'); finish(1); return; }
        const delay = restartDelays[restarts++];
        if (!update('backoff')) return;
        diagnostic(`Application exited (${signal ?? code}); retry ${restarts}/${restartDelays.length} in ${delay} ms. The room will restart closed.`);
        if (finished || stopping) return;
        restartTimer = setTimeout(launch, delay);
      });
      if (!update('running')) return;
      try { if (childPid) writeFileSync(pidPath, String(childPid)); } catch { abort(); }
    };
    const poll = setInterval(() => {
      if (!existsSync(stopPath)) return;
      let request;
      try { request = readJSON(stopPath); } catch { return; }
      if (request.token === token) stop();
    }, 100);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try { launch(); } catch (error) { diagnostic(`Application launch failed (${error.code ?? 'spawn-error'}).`); abort(); }
  });
}

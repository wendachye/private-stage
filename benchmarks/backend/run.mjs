import { spawn } from 'node:child_process';
import { Agent, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = fileURLToPath(new URL('.', import.meta.url));
const project = resolve(here, '../..');
const requestCount = Number(process.env.BENCH_REQUESTS ?? 1200);
const rounds = Number(process.env.BENCH_ROUNDS ?? 3);
const concurrencies = [1, 15, 50];
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = join(here, 'results', runId);
await mkdir(output, { recursive: true });
const versions = Object.fromEntries(await Promise.all(['fastify', 'next'].map(async name => [name, JSON.parse(await readFile(join(project, 'node_modules', name, 'package.json'), 'utf8')).version])));
const report = { runId, startedAtUTC: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, versions, requestCount, rounds, concurrencies, workloadSHA256: createHash('sha256').update(await readFile(join(here, 'workload.mjs'))).digest('hex'), fixture: { participants: 15, messages: 30, pins: 5, initialReturnedAudit: 200 }, servers: [], cases: [], errors: [] };
let active;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const getPort = () => new Promise((resolve, reject) => { const socket = createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
async function control(port, action) {
  const response = await fetch(`http://127.0.0.1:${port}/api/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Control ${action}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0; }
async function load(port, operation, concurrency, count, validate = false) {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency, scheduling: 'fifo' });
  let counter = 0, errors = 0, bytes = 0, sampled = 0;
  const statuses = {}, latencies = [], failures = [];
  const start = performance.now(), cpu = process.cpuUsage();
  async function worker() {
    while (counter < count) {
      const index = counter++;
      const startRequest = performance.now();
      const body = operation === 'write' ? JSON.stringify({ locked: index % 2 === 0 }) : undefined;
      await new Promise(resolve => {
        let complete = false;
        const finish = failure => { if (complete) return; complete = true; latencies.push(performance.now() - startRequest); if (failure) { errors++; if (failures.length < 5) failures.push(String(failure)); } resolve(); };
        const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/bench', method: body ? 'POST' : 'GET', agent, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, response => {
          const capture = validate || index % 100 === 0;
          const chunks = [];
          statuses[response.statusCode] = (statuses[response.statusCode] ?? 0) + 1;
          response.on('data', chunk => { bytes += chunk.length; if (capture) chunks.push(chunk); });
          response.on('error', finish);
          response.on('end', () => {
            if (response.statusCode !== 200) return finish(`HTTP ${response.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 300)}`);
            if (capture) {
              try { const state = JSON.parse(Buffer.concat(chunks).toString()); if (state.participants.length !== 15 || state.messages.length !== 30 || state.pins.length !== 5 || state.audit.length !== 200 || state.session.state !== 'live') throw new Error('Fixture contract mismatch'); sampled++; }
              catch (error) { return finish(error.message); }
            }
            finish();
          });
        });
        request.setTimeout(15000, () => request.destroy(new Error('request timeout')));
        request.on('error', finish);
        request.end(body);
      });
    }
  }
  try { await Promise.all(Array.from({ length: concurrency }, worker)); }
  finally { agent.destroy(); }
  const elapsedMs = performance.now() - start;
  latencies.sort((a, b) => a - b);
  return { elapsedMs, requests: count, requestsPerSecond: count / elapsedMs * 1000, p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99), maxMs: latencies.at(-1), errors, statuses, bytes, averageResponseBytes: bytes / count, sampledResponseContracts: sampled, clientCPU: process.cpuUsage(cpu), failures };
}
async function start(kind) {
  const port = await getPort();
  const args = kind === 'next' ? [join(project, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)] : [join(here, `${kind}-server.mjs`)];
  const child = spawn(process.execPath, args, { cwd: kind === 'next' ? join(here, 'next') : project, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', BENCH_DATA_DIR: join(output, 'fixtures', kind) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  active = child;
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${kind} exited: ${log}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return { child, port, getLog: () => log }; } catch {}
    await wait(100);
  }
  throw new Error(`${kind} readiness timed out: ${log}`);
}
try {
  for (const backend of ['node', 'fastify', 'next']) {
    const server = await start(backend);
    report.servers.push({ backend, port: server.port, pid: server.child.pid });
    console.log(JSON.stringify({ event: 'started', backend, port: server.port, pid: server.child.pid }));
    try {
      const fixture = await control(server.port, 'reset');
      const smoke = await load(server.port, 'read', 1, 1, true);
      if (smoke.errors) throw new Error(`${backend} smoke failed: ${JSON.stringify(smoke.failures)}`);
      for (const operation of ['read', 'write']) for (const concurrency of concurrencies) for (let round = 1; round <= rounds; round++) {
        await control(server.port, 'reset');
        const warmup = await load(server.port, operation, concurrency, 100);
        if (warmup.errors) throw new Error(`${backend} warmup failed: ${JSON.stringify(warmup.failures)}`);
        await control(server.port, 'begin');
        const measured = await load(server.port, operation, concurrency, requestCount);
        const serverMetrics = await control(server.port, 'metrics');
        const result = { backend, operation, concurrency, round, ...measured, serverMetrics };
        report.cases.push(result);
        console.log(JSON.stringify({ event: 'round', backend, operation, concurrency, round, rps: Math.round(result.requestsPerSecond), p95: Number(result.p95Ms.toFixed(2)), errors: result.errors }));
        await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
      }
      await control(server.port, 'close');
    } finally {
      server.child.kill();
      await new Promise(resolve => { if (server.child.exitCode !== null) resolve(); else { server.child.once('exit', resolve); setTimeout(resolve, 3000); } });
      await writeFile(join(output, `${backend}.log`), server.getLog());
      active = undefined;
      console.log(JSON.stringify({ event: 'stopped', backend, pid: server.child.pid }));
    }
  }
} catch (error) {
  report.errors.push(String(error.stack ?? error)); process.exitCode = 1;
  console.log(JSON.stringify({ event: 'failed', error: String(error.stack ?? error) }));
} finally {
  if (active) active.kill();
  report.finishedAtUTC = new Date().toISOString();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(join(here, 'latest-results.txt'), join(output, 'results.json'));
  console.log(JSON.stringify({ event: 'finished', output, cases: report.cases.length, errors: report.errors.length }));
}

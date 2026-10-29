import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
const summaryPath=resolve(process.argv[2] ?? join(here,'summary.json'));
const data=JSON.parse(await readFile(summaryPath,'utf8'));
const raw=JSON.parse(await readFile(data.resultsPath,'utf8'));
const label={node:'Node HTTP baseline',fastify:`Fastify ${raw.versions?.fastify ?? '(version not recorded)'}`,next:`Next.js ${raw.versions?.next ?? '(version not recorded)'} API`};
const n=value=>value.toFixed(2);
const table=operation=>[
  '| Backend | Concurrent requests | Requests/s | p50 ms | p95 ms | p99 ms | Errors |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...data.summary.filter(row=>row.operation===operation).map(row=>`| ${label[row.backend]} | ${row.concurrency} | ${Math.round(row.requestsPerSecond).toLocaleString('en')} | ${n(row.p50Ms)} | ${n(row.p95Ms)} | ${n(row.p99Ms)} | ${row.errors} |`),
].join('\n');
const target=data.summary.filter(row=>row.concurrency===15);
const fastRead=target.find(row=>row.backend==='fastify'&&row.operation==='read'),nextRead=target.find(row=>row.backend==='next'&&row.operation==='read');
const fastWrite=target.find(row=>row.backend==='fastify'&&row.operation==='write'),nextWrite=target.find(row=>row.backend==='next'&&row.operation==='write');
const formatTime=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'long',timeStyle:'medium'}).format(new Date(value));
const outputPath=join(dirname(data.resultsPath),'report.md');
const link=path=>relative(dirname(outputPath),path).replaceAll('\\','/');
const source=link(data.resultsPath);
const teardown=data.portChecks?.length ? `Recorded teardown checks: ${data.portChecks.map(check=>`port ${check.port}: ${check.state}`).join('; ')}.` : 'This result has no recorded server ports; teardown could not be checked from its metadata.';
const responseBytes=data.summary.reduce((total,row)=>total+row.averageResponseBytes,0)/data.summary.length;
const text=`# Backend comparison for Private Stage

**Recommendation: keep Next.js + shadcn/ui + React Query for the frontend, and Fastify for the authoritative HTTP/realtime/media-gateway backend. Keep SQLite WAL with FULL durability for the initial single-host deployment, subject to the persistence and growth limits below.**

This recommendation follows a matched local measurement. It is not a universal framework ranking and does not certify LiveKit, Discord, WAN reachability, or a 15-person media session. PostgreSQL was not benchmarked.

Measured on ${formatTime(raw.startedAtUTC)} through ${formatTime(raw.finishedAtUTC)}, KL time (UTC+08:00). The run lasted ${data.elapsedSeconds.toFixed(1)} seconds, excluding the separate production build.

## Decision at the target concurrency

At 15 concurrent HTTP requests, Fastify delivered ${Math.round(fastRead.requestsPerSecond).toLocaleString('en')} full snapshots/s against ${Math.round(nextRead.requestsPerSecond).toLocaleString('en')} for production Next API routes: approximately ${(fastRead.requestsPerSecond/nextRead.requestsPerSecond).toFixed(2)} times the throughput. Median-of-round p95 was ${n(fastRead.p95Ms)} ms versus ${n(nextRead.p95Ms)} ms.

Durable audited policy writes reached ${Math.round(fastWrite.requestsPerSecond)} requests/s for Fastify and ${Math.round(nextWrite.requestsPerSecond)} for Next, approximately ${((fastWrite.requestsPerSecond/nextWrite.requestsPerSecond-1)*100).toFixed(0)}% higher measured throughput. Their p95 latencies were ${n(fastWrite.p95Ms)} ms and ${n(nextWrite.p95Ms)} ms. Bare Node was close to Fastify on durable writes; those small differences should not be treated as a meaningful winner.

Fastify is therefore the stronger measured API option for this workload. It also fits the application’s existing authenticated SSE, explicit command boundary, and custom WebSocket media gateway. Removing those controls merely to use Next API routes would not improve the application’s requirements. A hand-written Node HTTP server is only a measurement baseline; this experiment did not equip it with the production framework’s security, validation integration, routing, or operational features.

## Matched methodology

- Recorded environment: ${raw.platform}/${raw.architecture}, Node ${raw.node}. Hardware, competing workloads, CPU affinity, and power settings must be recorded separately for each reproduction; this generator does not assume the original desktop.
- Same Node ${raw.node}; ${label.fastify} and production ${label.next} App Router, Node runtime, force-dynamic API routes. Next’s small isolated benchmark app was built once with the installed Next CLI; no development-mode route measurements were used.
- All three adapters import the same snapshotted esbuild bundle of the actual StageService and AuthService code. Next then compiles that common input through its production build. Input SHA-256: \`${raw.workloadSHA256}\`.
- Each case/round gets a fresh, identically seeded pair of file-backed SQLite databases: 15 admitted accounts, four stage members, 30 realistic synthetic chat messages, five pins, and a saturated 200-entry admin audit response. Data is fictional and entirely separate from the running app’s database.
- The HTTP adapters are intentionally minimal and do not include the complete production middleware/SSE/WebSocket stack. Every measured request performs the actual AuthService SQLite preview-session lookup and role mapping. This is a fixed authenticated synthetic session, not a live Discord request or a benchmark of encrypted-cookie parsing, OAuth, token refresh, or fresh membership verification.
- Read: full owner RoomSnapshot including chat, pins, participants, and the latest 200 audit entries. Write: strict Zod validation of \`{ locked: boolean }\`, actual serialized \`room.lock\` command, durable state transaction plus audit insertion, and the resulting full snapshot. Mean of the per-case average response sizes was ${Math.round(responseBytes).toLocaleString('en')} bytes; inspect raw cases for adapter/operation differences.
- Real service/database work is included. Media side effects are no-op benchmark adapters; no SFU traffic, screen capture, or external media-server acknowledgement is part of these measurements.
- HTTP/1.1 loopback with keep-alive and 1, 15, or 50 concurrent requests. Each cell has ${raw.rounds} rounds of ${raw.requestCount.toLocaleString('en')} measured requests after 100 warmup requests. Fixture seeding and warmups are excluded from per-round request metrics.
- Sequential backend order was Node, Fastify, then Next; the backends were not loaded simultaneously. Normal temporal/disk/JIT variability remains possible because backend order was not randomized and CPU affinity/power settings were not controlled.
- ${data.totalMeasuredRequests.toLocaleString('en')} measured requests completed with ${data.totalErrors} HTTP/network errors and ${data.processErrors.length} process errors. All responses were checked for HTTP status and their received byte counts were recorded; every hundredth measured response was parsed to verify the 15-participant/30-message/5-pin/200-audit contract. No requests targeted the user app at port 3210.
- Tables report the median of the ${raw.rounds} per-round RPS/p50/p95/p99 figures, not a pooled percentile or a confidence interval. Each table row represents ${(raw.rounds*raw.requestCount).toLocaleString('en')} measured requests.

## Full snapshot reads

${table('read')}

## Durable audited policy writes

${table('write')}

## Process CPU and memory at 15 concurrent requests

| Backend | Workload | Server CPU core-equivalent | Driver CPU core-equivalent | Sampled server RSS MiB |
|---|---|---:|---:|---:|
${target.map(row=>`| ${label[row.backend]} | ${row.operation} | ${n(row.serverCPUCoreEquivalent)} | ${n(row.clientCPUCoreEquivalent)} | ${row.serverRSSMiB.toFixed(1)} |`).join('\n')}

CPU core-equivalent is process CPU time divided by request wall time: 1.0 is approximately one fully occupied logical CPU, not 100% of a multicore machine. Process CPU can include auxiliary threads. RSS was sampled after each round, without forcing GC; it is not peak or long-term steady-state memory and does not predict the combined Next+Fastify application’s total memory.

The read adapters were near one logical CPU while the separate load driver remained below one. That supports a server/snapshot/serialization processing limit rather than an obviously saturated driver, but does not fully rule out shared-machine or transport effects. The driver itself was not independently capacity-calibrated.

Write throughput converged much more closely between Fastify and bare Node, and increased concurrency mainly increased queue latency. The service serializes commands and rewrites its complete JSON state inside a durable transaction. These observations are consistent with a serialized persistence/commit cost, not proof that SQLite alone is the bottleneck. We did not isolate fsync, JSON cloning, audit queries, or event-loop delay into component profiles. Direct event-loop lag was not measured.

## Database choice and limits

Independent verification of the current StageStore configuration observed SQLite ${data.databaseChecks.sqliteVersion}, journal_mode=${data.databaseChecks.journalMode}, synchronous=${data.databaseChecks.synchronous} (${data.databaseChecks.synchronous===2?'FULL':'not FULL'}), foreign_keys=${data.databaseChecks.foreignKeys}, busy_timeout=${data.databaseChecks.busyTimeoutMs} ms. This post-run check is not an in-request trace of database settings; preserve the source bundle hash when comparing runs.

SQLite is a reasonable initial choice for this single authoritative room process on a local SSD. WAL supports concurrent readers and a writer, but still only one writer at a time; it is not a multi-host shared database. The measured policy-write rate is far above the expected moderation/scheduling rate for 10–15 participants, but is not a session-wide acceptance result. See [SQLite WAL concurrency](https://sqlite.org/wal.html) and [SQLite deployment guidance](https://sqlite.org/whentouse.html).

The present storage model is the more important scaling limit: it keeps room policy and current-session social state in one JSON record. More messages, devices, restrictions, schedules, and retained metadata increase cloning, serialization, and rewrite cost. This benchmark used 30 messages, not the service’s full 1,000-message live-session limit or months of retained schedules/audits. It also used separate read/write phases, not a realistic mixed workload with SSE fanout.

Before larger sessions or long retention, benchmark a near-limit session and long-lived audit/schedule history; monitor event-loop delay during fsync; consider normalized message/admission/policy tables and a dedicated database worker while preserving one authoritative command order. Simply moving the same hot JSON row to PostgreSQL would not remove application-level serialization or row contention.

PostgreSQL was **not installed, run, or measured** here. Choose it when the deployment needs multi-process/multi-host coordination, substantially more concurrent writers, or managed database operations, then run a matched schema/workload benchmark with equal durability. No claim that SQLite is faster than PostgreSQL, or vice versa, is supported by this test.

## Evidence and reproduction

- [Per-round results JSON](${source}) contains timings, status/error counts, response bytes, process CPU/RSS, and sample counts.
- [Aggregated measurements](${link(summaryPath)}) contains the medians, actual SQLite verification, and teardown checks.
- [Shared real workload](${link(join(here,'workload.ts'))}), [load driver/orchestrator](${link(join(here,'run.mjs'))}), and [isolated Next production API](${link(join(here,'next/app/api/bench/route.ts'))}) are saved for inspection.
- ${teardown} The harness targets isolated loopback ports and does not change the app, router, firewall, cloud resources, or Git history.

From the project root in PowerShell:

\`\`\`powershell
node .\\node_modules\\esbuild\\bin\\esbuild .\\benchmarks\\backend\\workload.ts --bundle --platform=node --format=esm --target=node24 --outfile=.\\benchmarks\\backend\\workload.mjs
node .\\node_modules\\next\\dist\\bin\\next build .\\benchmarks\\backend\\next
node .\\benchmarks\\backend\\run.mjs
node .\\benchmarks\\backend\\summarize.mjs
node .\\benchmarks\\backend\\report.mjs
\`\`\`

Rebuilding the shared bundle intentionally captures the then-current application source; retain its new hash and do not combine measurements from different hashes as a matched comparison. Generated databases and the isolated Next build are under benchmarks/backend. Real Discord, WAN/TLS, media enforcement, 10–15-person capacity, cloud Linux performance, and PostgreSQL comparisons remain separate validation tasks.
`;
await mkdir(dirname(outputPath),{recursive:true});
await writeFile(outputPath,text,'utf8');
console.log(JSON.stringify({saved:outputPath,readSpeedup:fastRead.requestsPerSecond/nextRead.requestsPerSecond,writeSpeedup:fastWrite.requestsPerSecond/nextWrite.requestsPerSecond}));

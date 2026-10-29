import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageService } from '../../backend/src/domain/stage-service.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const resultsPath = resolve(process.argv[2] ?? (await readFile(join(here, 'latest-results.txt'), 'utf8')).trim());
const report = JSON.parse(await readFile(resultsPath, 'utf8'));
const median = values => { const sorted = [...values].sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)]; };
const summary = [];
for (const backend of ['node','fastify','next']) for (const operation of ['read','write']) for (const concurrency of report.concurrencies) {
  const cases = report.cases.filter(value => value.backend===backend&&value.operation===operation&&value.concurrency===concurrency);
  if (cases.length!==report.rounds) throw new Error(`Missing cases: ${backend}/${operation}/${concurrency}`);
  summary.push({backend,operation,concurrency,requests:cases.reduce((total,value)=>total+value.requests,0),requestsPerSecond:median(cases.map(value=>value.requestsPerSecond)),minRoundRPS:Math.min(...cases.map(value=>value.requestsPerSecond)),maxRoundRPS:Math.max(...cases.map(value=>value.requestsPerSecond)),p50Ms:median(cases.map(value=>value.p50Ms)),p95Ms:median(cases.map(value=>value.p95Ms)),p99Ms:median(cases.map(value=>value.p99Ms)),errors:cases.reduce((total,value)=>total+value.errors,0),averageResponseBytes:median(cases.map(value=>value.averageResponseBytes)),serverCPUCoreEquivalent:median(cases.map(value=>(value.serverMetrics.cpu.user+value.serverMetrics.cpu.system)/1000/value.elapsedMs)),clientCPUCoreEquivalent:median(cases.map(value=>(value.clientCPU.user+value.clientCPU.system)/1000/value.elapsedMs)),serverRSSMiB:median(cases.map(value=>value.serverMetrics.memory.rss/1048576))});
}
const portChecks = [];
for(const port of (report.servers ?? []).map(server=>server.port)) portChecks.push(await new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});let done=false;const finish=state=>{if(done)return;done=true;socket.destroy();resolve({port,state})};socket.setTimeout(500,()=>finish('timeout'));socket.once('connect',()=>finish('still-listening'));socket.once('error',error=>finish(error.code==='ECONNREFUSED'?'closed':error.code))}));
// Independently verify the Node24/SQLite default used by the snapshotted StageStore.
const service = new StageService({databasePath:join(here,'durability-check','stage.sqlite')});
const databaseChecks = {sqliteVersion:service.store.db.prepare('SELECT sqlite_version() AS version').get().version,journalMode:service.store.db.prepare('PRAGMA journal_mode').get().journal_mode,synchronous:service.store.db.prepare('PRAGMA synchronous').get().synchronous,foreignKeys:service.store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,busyTimeoutMs:service.store.db.prepare('PRAGMA busy_timeout').get().timeout};
service.close();
const overall = {summary,portChecks,databaseChecks,totalMeasuredRequests:report.cases.reduce((total,value)=>total+value.requests,0),totalErrors:report.cases.reduce((total,value)=>total+value.errors,0),processErrors:report.errors,elapsedSeconds:(Date.parse(report.finishedAtUTC)-Date.parse(report.startedAtUTC))/1000,resultsPath};
await writeFile(join(here,'summary.json'),JSON.stringify(overall,null,2));
console.log(JSON.stringify(overall,null,2));

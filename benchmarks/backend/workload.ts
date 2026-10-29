import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { StageService } from '../../backend/src/domain/stage-service.ts';
import { AuthService } from '../../backend/src/auth/auth-service.ts';
import type { Principal } from '../../shared/types.ts';

const writeSchema = z.object({ locked: z.boolean() }).strict();
type Fixture = { service: StageService; auth: AuthService; sessionId: string; deviceId: string; actor: Principal };
let fixture: Fixture | undefined;
let fixtureSequence = 0;
let startCPU = process.cpuUsage();
let startTime = performance.now();
let handled = 0;

export async function resetFixture() {
  fixture?.auth.close();
  fixture?.service.close();
  const directory = join(process.env.BENCH_DATA_DIR!, `fixture-${++fixtureSequence}`);
  mkdirSync(directory, { recursive: true });
  const service = new StageService({ databasePath: join(directory, 'stage.sqlite'), ownerUserId: 'preview-owner', policy: { chatMessagesPer10Seconds: 100000, reactionsPer10Seconds: 100000 } });
  await service.startupClose();
  const auth = new AuthService({ databasePath: join(directory, 'auth.sqlite'), encryptionKey: randomBytes(32).toString('hex'), guildId: 'benchmark-only', clientId: '', clientSecret: '', preview: true, cacheSeconds: 30, maxStaleSeconds: 300, adminConfiguration: () => service.getAdminConfiguration() });
  const deviceId = 'benchmark-owner-device';
  const sessionId = auth.previewLogin('owner', deviceId);
  const actor = await auth.principal(sessionId, deviceId);
  await service.execute(actor, { type: 'session.open', title: 'Matched backend benchmark: 15 participants' });
  await service.execute(actor, { type: 'room.join' });
  const people: Principal[] = [actor];
  for (let index = 1; index < 15; index++) {
    const person: Principal = { userId: `benchmark-member-${index}`, displayName: `Benchmark member ${index}`, deviceId: `benchmark-device-${index}`, isAdmin: false, isOwner: false };
    people.push(person);
    await service.execute(person, { type: 'room.join' });
  }
  for (const person of people.slice(0, 4)) await service.execute(actor, { type: 'member.stage', userId: person.userId, onStage: true });
  for (let index = 0; index < 30; index++) {
    await service.execute(people[index % people.length], { type: 'chat.send', text: `Matched fixture message ${index + 1}: review the current chart, discuss the setup, and keep the conversation in this session.`, clientId: `seed-message-${index}` });
  }
  for (const message of service.snapshot(actor).messages.slice(0, 5)) await service.execute(actor, { type: 'chat.pin', messageId: message.id, pinned: true });
  // Seed the same saturated 200-event audit response before measuring all adapters.
  for (let index = 0; index < 205; index++) await service.execute(actor, { type: 'room.lock', locked: index % 2 === 0 });
  await service.execute(actor, { type: 'room.lock', locked: false });
  service.store.checkpoint();
  fixture = { service, auth, actor, deviceId, sessionId };
  handled = 0;
  return { participants: 15, messages: 30, pins: 5, auditReturned: service.snapshot(actor).audit?.length, sqliteJournalMode: 'WAL', authentication: 'Actual AuthService preview-session lookup; no external Discord requests', fixtureSequence };
}

export function beginMetrics() { handled = 0; startCPU = process.cpuUsage(); startTime = performance.now(); return { ok: true }; }
export function metrics() { return { requests: handled, elapsedMs: performance.now() - startTime, cpu: process.cpuUsage(startCPU), memory: process.memoryUsage(), uptime: process.uptime() }; }
export async function perform(method: string, body: unknown) {
  if (!fixture) throw new Error('Benchmark fixture has not been initialized.');
  const actor = await fixture.auth.principal(fixture.sessionId, fixture.deviceId);
  const result = method === 'GET' ? fixture.service.snapshot(actor) : (await fixture.service.execute(actor, { type: 'room.lock', ...writeSchema.parse(body) })).snapshot;
  handled++;
  return result;
}
export function closeFixture() { fixture?.auth.close(); fixture?.service.close(); fixture = undefined; }
export async function control(body: { action?: string }) {
  if (body.action === 'reset') return resetFixture();
  if (body.action === 'begin') return beginMetrics();
  if (body.action === 'metrics') return metrics();
  if (body.action === 'close') { closeFixture(); return { ok: true }; }
  return { error: 'Unknown control action' };
}

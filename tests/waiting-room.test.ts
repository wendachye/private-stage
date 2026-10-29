import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageService, DomainError } from '../backend/src/domain/stage-service.ts';
import type { MediaEffects } from '../backend/src/domain/stage-service.ts';
import type { Principal, MediaPolicy } from '../shared/types.ts';

const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'owner-browser', isOwner: true, isAdmin: true };
const admin: Principal = { userId: 'admin', displayName: 'Admin', deviceId: 'admin-browser', isOwner: false, isAdmin: true };
const member = (userId: string, deviceId = userId + '-browser'): Principal => ({ userId, displayName: userId, deviceId, isOwner: false, isAdmin: false });
const denied = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;
const status = (expected: number) => (error: unknown): boolean => error instanceof DomainError && error.status === expected;
function fixture(media?: Partial<MediaEffects>) {
  let now = Date.parse('2026-10-29T03:00:00.000Z');
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId, now: () => now, media });
  return { service, advance: (seconds: number) => { now += seconds * 1000; } };
}

test('opening atomically creates a waiting room and admits only the opening admin device on stage without a microphone grant', async () => {
  const { service } = fixture();
  try {
    const opened = await service.execute(owner, { type: 'session.open', mode: 'stage', title: 'Waiting for the host' });
    assert.equal(opened.snapshot.session?.state, 'waiting');
    assert.equal(opened.snapshot.session?.startedAt, null);
    assert.equal(opened.snapshot.session?.waitingAudienceCanSpeak, false);
    assert.equal(opened.admission?.deviceId, owner.deviceId);
    assert.equal(opened.snapshot.self.admission?.id, opened.admission?.id);
    assert.equal(opened.snapshot.participants.find(person => person.userId === owner.userId)?.onStage, true);
    assert.equal(opened.snapshot.self.microphoneOwned, false);
    assert.equal(service.mediaPolicy(opened.admission!.identity)?.allowedSources.includes('microphone'), false);
    assert.equal(service.snapshot({ ...owner, deviceId: 'another-admin-device' }).self.admission, null);
    const stable = await service.admit(owner);
    assert.equal(stable.id, opened.admission!.id, 'Connecting after the open response must reuse its admission.');
    const audience = member('audience');
    await service.admit(audience);
    assert.equal(service.snapshot(audience).self.canSpeak, false);
    const sent = await service.execute(audience, { type: 'chat.send', text: 'Hello before going live', clientId: 'waiting-hello' });
    assert.equal(sent.snapshot.messages[0]?.text, 'Hello before going live');
    await assert.rejects(service.execute(audience, { type: 'share.reserve' }), denied('stage_required'));
  } finally { service.close(); }
});

test('waiting audience conversation toggles eligibility across devices while personal and group restrictions remain authoritative', async () => {
  const { service } = fixture();
  try {
    await service.execute(owner, { type: 'session.open', mode: 'stage' });
    const a = member('a'), second = member('a', 'second-device'), b = member('b');
    const aa = await service.admit(a), ab = await service.admit(second); await service.admit(b);
    await assert.rejects(service.execute(a, { type: 'mic.acquire' }), denied('microphone_blocked'));
    await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
    assert.equal(service.snapshot(a).self.canSpeak, true);
    assert.equal(service.snapshot(b).self.canSpeak, true);
    assert.equal(service.snapshot(a).self.microphoneOwned, false, 'Allowing conversation cannot switch on a microphone.');
    await service.execute(a, { type: 'mic.acquire' });
    assert.equal(service.mediaPolicy(aa.identity)?.allowedSources.includes('microphone'), true);
    await service.execute(second, { type: 'mic.acquire' });
    assert.equal(service.mediaPolicy(aa.identity)?.allowedSources.includes('microphone'), false);
    assert.equal(service.mediaPolicy(ab.identity)?.allowedSources.includes('microphone'), true);
    await service.execute(owner, { type: 'member.microphone', userId: a.userId, action: 'block' });
    await service.execute(owner, { type: 'room.waiting-audio', enabled: false });
    await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
    assert.equal(service.snapshot(a).self.canSpeak, false);
    assert.equal(service.snapshot(second).self.canSpeak, false);
    assert.equal(service.mediaPolicy(ab.identity)?.allowedSources.includes('microphone'), false);
    await service.execute(owner, { type: 'group.microphone', action: 'audience' });
    assert.equal(service.snapshot(b).self.canSpeak, false);
    await service.execute(owner, { type: 'group.microphone', action: 'allow' });
    assert.equal(service.snapshot(a).self.canSpeak, false, 'Group restore must retain an individual block.');
    assert.equal(service.snapshot(b).self.canSpeak, true);
    await service.execute(b, { type: 'mic.acquire' });
    await service.execute(owner, { type: 'room.waiting-audio', enabled: false });
    assert.equal(service.snapshot(b).self.microphoneOwned, false);
    await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
    assert.equal(service.snapshot(b).self.microphoneOwned, false, 'Re-enabling never revives a revoked microphone lease.');
  } finally { service.close(); }
});

test('Go live keeps the same room, chat, speaking mode and audience microphone choice', async () => {
  const observed: MediaPolicy[][] = [];
  const { service, advance } = fixture({ async reconcile(_room, policies) { observed.push(structuredClone(policies)); } });
  try {
    const opened = await service.execute(owner, { type: 'session.open', mode: 'stage' });
    const audience = member('a'); const audienceAdmission = await service.admit(audience);
    const otherDevice = await service.admit(member('a', 'another-device'));
    await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
    await service.execute(owner, { type: 'mic.acquire' }); await service.execute(audience, { type: 'mic.acquire' });
    await service.execute(audience, { type: 'chat.send', text: 'Keep waiting conversation on transition' });
    const before = service.snapshot(audience);
    advance(15); observed.length = 0;
    const live = await service.execute(admin, { type: 'session.start' });
    assert.equal(live.snapshot.session?.state, 'live');
    assert.equal(live.snapshot.session?.id, opened.snapshot.session?.id);
    assert.equal(live.snapshot.session?.roomName, opened.snapshot.session?.roomName);
    assert.equal(live.snapshot.session?.openedAt, opened.snapshot.session?.openedAt);
    assert.equal(live.snapshot.session?.startedAt, '2026-10-29T03:00:15.000Z');
    assert.equal(live.snapshot.session?.mode, 'open');
    assert.equal(live.snapshot.session?.waitingAudienceCanSpeak, true);
    assert.equal(service.snapshot(audience).self.admission?.id, before.self.admission?.id);
    assert.equal(service.snapshot(audience).messages[0]?.text, before.messages[0]?.text);
    assert.equal(service.snapshot(audience).self.canSpeak, true);
    assert.equal(service.snapshot(audience).self.microphoneOwned, true);
    assert.equal(service.snapshot(owner).self.microphoneOwned, true, 'A current approved stage speaker retains their own mic choice.');
    assert.equal(service.mediaPolicy(audienceAdmission.identity)?.allowedSources.includes('microphone'), true);
    assert.equal(service.mediaPolicy(otherDevice.identity)?.allowedSources.includes('microphone'), false);
    assert.ok(observed.length > 0, 'The live transition must reconcile actual SFU permissions.');
    assert.ok(observed.every(policies => policies.find(policy => policy.identity === audienceAdmission.identity)?.allowedSources.includes('microphone')));
    await service.execute(audience, { type: 'mic.acquire' });
  } finally { service.close(); }
});

test('only an admin controls waiting audio and a serialized Go live transition succeeds once', async () => {
  const { service } = fixture();
  try {
    await service.execute(owner, { type: 'session.open', mode: 'stage' }); await service.admit(member('a'));
    await assert.rejects(service.execute(member('a'), { type: 'session.start' }), denied('admin_required'));
    await assert.rejects(service.execute(member('a'), { type: 'room.waiting-audio', enabled: true }), denied('admin_required'));
    await assert.rejects(service.execute(owner, { type: 'room.waiting-audio', enabled: 'yes' }), status(400));
    await service.execute(owner, { type: 'room.mode', mode: 'open' });
    assert.equal(service.snapshot(owner).session?.mode, 'open');
    const transitions = await Promise.allSettled([service.execute(owner, { type: 'session.start' }), service.execute(admin, { type: 'session.start' })]);
    assert.equal(transitions.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(transitions.filter(result => result.status === 'rejected' && denied('already_live')(result.reason)).length, 1);
    await assert.rejects(service.execute(owner, { type: 'room.waiting-audio', enabled: true }), denied('waiting_room_required'));
  } finally { service.close(); }
});

test('failed SFU transition confirmation keeps the chosen mode and leaves a retryable waiting room', async () => {
  let fail = false;
  const { service } = fixture({ async reconcile() { if (fail) throw new Error('Isolated SFU denial failure'); } });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'stage' });
    const a = member('a'); const admission = await service.admit(a);
    await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
    await service.execute(a, { type: 'mic.acquire' });
    fail = true;
    await assert.rejects(service.execute(owner, { type: 'session.start' }), /Isolated SFU denial failure/);
    assert.equal(service.snapshot(owner).session?.state, 'waiting');
    assert.equal(service.snapshot(owner).session?.startedAt, null);
    assert.equal(service.snapshot(a).self.canSpeak, true);
    assert.equal(service.snapshot(a).self.microphoneOwned, true);
    assert.equal(service.snapshot(owner).session?.mode, 'open');
    assert.equal(service.snapshot(owner).mediaSyncPending, true);
    assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('microphone'), true);
    fail = false;
    await service.execute(owner, { type: 'session.start' });
    assert.equal(service.snapshot(owner).session?.state, 'live');
    assert.equal(service.snapshot(owner).mediaSyncPending, false);
  } finally { service.close(); }
});

test('ending or restarting a scheduled waiting room closes its admissions and does not revive waiting audio', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'stage-waiting-restart-'));
  const databasePath = join(folder, 'stage.sqlite');
  let service: StageService | undefined;
  try {
    service = new StageService({ databasePath, ownerUserId: owner.userId });
    const schedule = await service.execute(owner, { type: 'schedule.save', title: 'Scheduled waiting room', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' });
    const id = schedule.snapshot.schedules[0]!.id;
    const opened = await service.execute(owner, { type: 'session.open', mode: 'stage', scheduleId: id });
    assert.equal(opened.snapshot.schedules[0]?.status, 'scheduled');
    assert.equal(opened.snapshot.session?.state, 'waiting');
    await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
    const old = await service.admit(member('a'));
    service.close(); service = undefined;
    service = new StageService({ databasePath, ownerUserId: owner.userId });
    assert.equal(service.snapshot(owner).session, null);
    assert.equal(service.snapshot(owner).schedules[0]?.status, 'completed');
    assert.equal(service.mediaPolicy(old.identity)?.active, false);
    assert.equal(service.snapshot(owner).cleanupPending, true);
    await service.startupClose();
    await service.execute(owner, { type: 'session.open', mode: 'stage' });
    assert.equal(service.snapshot(owner).session?.waitingAudienceCanSpeak, false);
    await service.execute(owner, { type: 'session.end' });
    assert.equal(service.snapshot(owner).session, null);
    assert.equal(service.snapshot(owner).cleanupPending, false);
  } finally { service?.close(); rmSync(folder, { recursive: true, force: true }); }
});

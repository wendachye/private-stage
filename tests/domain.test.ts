import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageService, DomainError } from '../backend/src/domain/stage-service.ts';
import type { MediaEffects } from '../backend/src/domain/stage-service.ts';
import type { Principal, MediaPolicy } from '../shared/types.ts';

const owner: Principal = { userId: 'owner', displayName: 'Owner', isOwner: true, isAdmin: true, deviceId: 'owner-browser' };
const admin: Principal = { userId: 'admin', displayName: 'Admin', isOwner: false, isAdmin: true, deviceId: 'admin-browser' };
const member = (id: string, deviceId = `${id}-browser`): Principal => ({ userId: id, displayName: `Member ${id}`, isAdmin: false, isOwner: false, deviceId });
const denied = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

function fixture(options: { media?: Partial<MediaEffects>; databasePath?: string } = {}) {
  let now = Date.parse('2026-10-29T02:00:00.000Z');
  const service = new StageService({ databasePath: options.databasePath ?? ':memory:', ownerUserId: owner.userId, now: () => now, media: options.media });
  return { service, advance: (seconds: number) => { now += seconds * 1000; } };
}

async function opened(service: StageService) {
  await service.execute(owner, { type: 'session.open', mode: 'stage', title: 'Research room' });
  await service.execute(owner, { type: 'session.start' });
  await service.admit(owner);
}

async function speaker(service: StageService, actor: Principal) {
  const admission = await service.admit(actor);
  await service.execute(owner, { type: 'member.stage', userId: actor.userId, onStage: true });
  return admission;
}

test('closed room and scheduled time never admit members or open media', async () => {
  const { service, advance } = fixture();
  try {
    await assert.rejects(service.execute(member('a'), { type: 'session.open', mode: 'stage' }), denied('admin_required'));
    await service.execute(owner, { type: 'schedule.save', title: 'Upcoming study', startsAt: '2026-10-29T10:01:00+08:00', endsAt: '2026-10-29T11:00:00+08:00' });
    advance(120);
    assert.equal(service.snapshot(member('a')).session, null);
    await assert.rejects(service.admit(member('a')), denied('room_closed'));
    await assert.rejects(service.execute(member('a'), { type: 'session.end' }), denied('admin_required'));
    assert.equal(service.snapshot(owner).audit?.filter(event => event.outcome === 'denied').length, 2);
  } finally { service.close(); }
});

test('simultaneous opens produce exactly one live instance, with unique identity after ending', async () => {
  const { service } = fixture();
  try {
    const results = await Promise.allSettled([service.execute(owner, { type: 'session.open', mode: 'stage' }), service.execute(admin, { type: 'session.open', mode: 'stage' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const first = service.snapshot(owner).session!;
    await service.execute(owner, { type: 'session.end' });
    await service.execute(owner, { type: 'session.end' });
    await service.execute(owner, { type: 'session.open', mode: 'stage' });
    const second = service.snapshot(owner).session!;
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.roomName, second.roomName);
  } finally { service.close(); }
});

test('schedules use instants, reject overlap, and cancelled/completed links cannot open again', async () => {
  const { service } = fixture();
  try {
    const result = await service.execute(owner, { type: 'schedule.save', title: 'Scheduled', startsAt: '2026-10-29T19:00:00+08:00', endsAt: '2026-10-29T20:00:00+08:00' });
    const schedule = result.snapshot.schedules[0];
    assert.equal(schedule.startsAt, '2026-10-29T11:00:00.000Z');
    await assert.rejects(service.execute(owner, { type: 'schedule.save', title: 'Overlapping', startsAt: '2026-10-29T11:30:00Z', endsAt: '2026-10-29T12:30:00Z' }), denied('schedule_overlap'));
    await assert.rejects(service.execute(owner, { type: 'schedule.save', title: 'Unzoned', startsAt: '2026-10-29T11:30', endsAt: '2026-10-29T12:30' }), denied('invalid_date'));
    await service.execute(owner, { type: 'schedule.cancel', id: schedule.id });
    await assert.rejects(service.execute(owner, { type: 'session.open', mode: 'stage', scheduleId: schedule.id }), denied('schedule_unavailable'));
    const next = await service.execute(owner, { type: 'schedule.save', title: 'New reservation', startsAt: schedule.startsAt, endsAt: schedule.endsAt });
    const scheduled = next.snapshot.schedules.find(item => item.status === 'scheduled')!;
    await service.execute(owner, { type: 'session.open', mode: 'stage', scheduleId: scheduled.id });
    await service.execute(owner, { type: 'session.end' });
    await assert.rejects(service.execute(owner, { type: 'session.open', mode: 'stage', scheduleId: scheduled.id }), denied('schedule_unavailable'));
  } finally { service.close(); }
});

test('lock permits a real existing device reconnect, excludes new devices and expires old reconnect grants', async () => {
  const { service, advance } = fixture();
  try {
    await opened(service);
    const actor = member('a'); const admission = await service.admit(actor);
    await service.setConnection(admission.identity, true);
    await service.execute(owner, { type: 'room.lock', locked: true });
    await service.setConnection(admission.identity, false);
    const resumed = await service.admit(actor);
    assert.equal(resumed.id, admission.id);
    await assert.rejects(service.admit(member('a', 'new-browser')), denied('room_locked'));
    await assert.rejects(service.admit(member('b')), denied('room_locked'));
    advance(91);
    assert.equal(service.mediaPolicy(admission.identity)?.active, false);
    await assert.rejects(service.admit(actor), denied('room_locked'));
    await service.admit(admin);
  } finally { service.close(); }
});

test('kick revokes all account device admissions and does not grant a lock bypass', async () => {
  const { service } = fixture();
  try {
    await opened(service);
    const a = await service.admit(member('a')); const a2 = await service.admit(member('a', 'second'));
    await service.execute(owner, { type: 'member.remove', userId: 'a', action: 'kick' });
    assert.equal(service.mediaPolicy(a.identity)?.active, false);
    assert.equal(service.mediaPolicy(a2.identity)?.active, false);
    const fresh = await service.admit(member('a'));
    assert.notEqual(fresh.id, a.id);
    await service.execute(owner, { type: 'room.lock', locked: true });
    await service.execute(owner, { type: 'member.remove', userId: 'a', action: 'kick' });
    await assert.rejects(service.admit(member('a')), denied('room_locked'));
  } finally { service.close(); }
});

test('session block expires with its instance, persistent ban survives until restored', async () => {
  const { service } = fixture();
  try {
    await opened(service); await service.admit(member('a')); await service.admit(member('b'));
    await service.execute(owner, { type: 'member.remove', userId: 'a', action: 'session-block' });
    await service.execute(owner, { type: 'member.remove', userId: 'b', action: 'ban' });
    await assert.rejects(service.admit(member('a', 'another')), denied('entry_blocked'));
    await service.execute(owner, { type: 'session.end' });
    await opened(service);
    await service.admit(member('a'));
    await assert.rejects(service.admit(member('b')), denied('entry_blocked'));
    await service.execute(owner, { type: 'member.restore', userId: 'b' });
    await service.admit(member('b'));
  } finally { service.close(); }
});

test('admins can discover a removed session-blocked member and restore access without reviving old admissions', async () => {
  const { service } = fixture();
  try {
    await opened(service);
    const actor = member('restore-target');
    const oldAdmission = await speaker(service, actor);
    await service.execute(owner, { type: 'member.remove', userId: actor.userId, action: 'session-block' });
    const blocked = service.snapshot(owner);
    assert.equal(blocked.participants.some(person => person.userId === actor.userId), false);
    assert.deepEqual(blocked.sessionBlocks, [{ userId: actor.userId, displayName: actor.displayName }]);
    assert.deepEqual(blocked.bans, [], 'The existing persistent-ban metadata remains separate and compatible.');
    assert.deepEqual(service.snapshot(admin).sessionBlocks, blocked.sessionBlocks);
    assert.equal(Object.hasOwn(service.snapshot(actor), 'sessionBlocks'), false, 'Ordinary members must not receive other members\' entry restrictions.');
    assert.equal(service.snapshot(actor).self.sessionBlocked, true);
    await assert.rejects(service.execute(actor, { type: 'member.restore', userId: actor.userId }), denied('admin_required'));
    await assert.rejects(service.admit(actor), denied('entry_blocked'));
    // One member may have both restrictions; the same existing restore command
    // clears both while leaving all prior admission credentials revoked.
    await service.execute(owner, { type: 'member.remove', userId: actor.userId, action: 'ban' });
    assert.deepEqual(service.snapshot(owner).bans, [{ userId: actor.userId, displayName: actor.displayName }]);
    await service.execute(owner, { type: 'member.restore', userId: actor.userId });
    assert.deepEqual(service.snapshot(owner).sessionBlocks, []);
    assert.deepEqual(service.snapshot(owner).bans, []);
    assert.equal(service.mediaPolicy(oldAdmission.identity)?.active, false);
    assert.equal(service.snapshot(actor).self.admission, null);
    const replacement = await service.admit(actor);
    assert.notEqual(replacement.id, oldAdmission.id);
    assert.equal(service.snapshot(actor).self.canShare, false, 'Restoring entry must not restore removed stage permission.');
  } finally { service.close(); }
});

test('owner protection and owner-only admin mapping hold under direct commands', async () => {
  const { service } = fixture();
  try {
    await opened(service); await service.admit(admin);
    await assert.rejects(service.execute(admin, { type: 'member.stage', userId: 'owner', onStage: false }), denied('owner_protected'));
    await assert.rejects(service.execute(admin, { type: 'member.remove', userId: 'owner', action: 'ban' }), denied('owner_protected'));
    await assert.rejects(service.execute(admin, { type: 'admin.assign', userId: 'a', admin: true }), denied('owner_required'));
    await assert.rejects(service.execute(admin, { type: 'admin.roles', roleIds: ['123'] }), denied('owner_required'));
    await service.execute(owner, { type: 'admin.assign', userId: 'a', admin: true });
    assert.deepEqual(service.getAdminConfiguration().explicitAdminUserIds, ['a']);
    await service.execute(owner, { type: 'admin.roles', roleIds: ['123', '123', '456'] });
    assert.deepEqual(service.getAdminConfiguration().adminRoleIds, ['123','456']);
    assert.equal(service.snapshot(member('a')).adminConfiguration, undefined);
    assert.equal(service.snapshot(member('a')).audit, undefined);
  } finally { service.close(); }
});

test('stage-only/open/Q&A and group restore preserve independent individual restrictions', async () => {
  const { service } = fixture();
  try {
    await opened(service); const a = member('a'); await service.admit(a);
    await assert.rejects(service.execute(a, { type: 'mic.acquire' }), denied('microphone_blocked'));
    await service.execute(owner, { type: 'room.mode', mode: 'open' });
    assert.equal(service.snapshot(a).self.canSpeak, true);
    assert.equal(service.snapshot(a).self.canShare, false);
    await service.execute(owner, { type: 'member.microphone', userId: 'a', action: 'block' });
    await service.execute(owner, { type: 'group.microphone', action: 'audience' });
    await service.execute(owner, { type: 'group.microphone', action: 'allow' });
    assert.equal(service.snapshot(a).self.canSpeak, false);
    await service.execute(owner, { type: 'member.microphone', userId: 'a', action: 'allow' });
    await service.execute(owner, { type: 'group.microphone', action: 'audience' });
    assert.equal(service.snapshot(a).self.canSpeak, false);
    await service.execute(owner, { type: 'member.stage', userId: 'a', onStage: true });
    assert.equal(service.snapshot(a).self.canSpeak, true, 'current-role audience mute does not block approved stage');
    await service.execute(owner, { type: 'room.mode', mode: 'qa' });
    await service.execute(owner, { type: 'member.stage', userId: 'a', onStage: false });
    await service.execute(a, { type: 'hand.set', raised: true });
    assert.equal(service.snapshot(owner).handRequests[0].userId, 'a');
    await service.execute(owner, { type: 'member.stage', userId: 'a', onStage: true });
    assert.equal(service.snapshot(owner).handRequests.length, 0);
  } finally { service.close(); }
});

test('explicit admin revocation preserves independent role authority until a verified refresh', async () => {
  const { service } = fixture();
  try {
    await opened(service); await service.admit(admin);
    const anotherAdmin = { ...admin, userId: 'other-admin', displayName: 'Other Admin', deviceId: 'other-admin-device' };
    await service.admit(anotherAdmin);
    await service.execute(owner, { type: 'admin.assign', userId: admin.userId, admin: true });
    await service.execute(owner, { type: 'admin.assign', userId: admin.userId, admin: false });
    assert.equal(service.getAdminConfiguration().explicitAdminUserIds.includes(admin.userId), false);
    assert.equal(service.snapshot(owner).participants.find(p => p.userId === admin.userId)?.isAdmin, true);
    await assert.rejects(service.execute(anotherAdmin, { type: 'member.remove', userId: admin.userId, action: 'kick' }), denied('owner_required'));
    await service.refreshPrincipal({ ...admin, isAdmin: false });
    await service.execute(anotherAdmin, { type: 'member.remove', userId: admin.userId, action: 'kick' });
    assert.equal(service.snapshot(owner).participants.some(p => p.userId === admin.userId), false);
  } finally { service.close(); }
});

test('ending removes persisted social content and reaction retry IDs while retaining audit records', async () => {
  const { service } = fixture();
  try {
    await opened(service);
    const result = await service.execute(owner, { type: 'chat.send', text: 'Transient social content' });
    const id = result.snapshot.messages[0].id;
    await service.execute(owner, { type: 'chat.pin', messageId: id, pinned: true });
    await service.execute(owner, { type: 'chat.react', messageId: id, emoji: '👍', clientId: 'ephemeral-retry-id' });
    await service.execute(owner, { type: 'reaction.send', emoji: '🎉', clientId: 'ephemeral-stage-id' });
    await service.execute(owner, { type: 'session.end' });
    const persisted = service.store.read<{ messages: unknown[]; pins: unknown[]; reactions: unknown[]; reactionRequests: Record<string, number> }>()!;
    assert.deepEqual(persisted.messages, []); assert.deepEqual(persisted.pins, []); assert.deepEqual(persisted.reactions, []); assert.deepEqual(persisted.reactionRequests, {});
    assert.ok(service.snapshot(owner).audit!.length > 0);
    assert.equal(JSON.stringify(service.snapshot(owner).audit).includes('Transient social content'), false);
  } finally { service.close(); }
});

test('microphone handoff denies previous publisher before enabling another device', async () => {
  const observations: MediaPolicy[][] = [];
  const { service } = fixture({ media: { async reconcile(_room, policies) { observations.push(structuredClone(policies)); } } });
  try {
    await opened(service);
    const a = member('a'), b = member('a', 'second');
    const aa = await speaker(service, a); const ab = await service.admit(b);
    await service.execute(a, { type: 'mic.acquire' }); observations.length = 0;
    await service.execute(b, { type: 'mic.acquire' });
    assert.equal(observations.length, 2);
    assert.equal(observations[0].filter(p => p.accountId === 'a' && p.allowedSources.includes('microphone')).length, 0);
    assert.equal(service.mediaPolicy(aa.identity)?.allowedSources.includes('microphone'), false);
    assert.equal(service.mediaPolicy(ab.identity)?.allowedSources.includes('microphone'), true);
  } finally { service.close(); }
});

test('failed microphone revoke keeps the requested replacement device denied', async () => {
  let shouldFail = false;
  const { service } = fixture({ media: { async reconcile() { if (shouldFail) throw new Error('media unavailable'); } } });
  try {
    await opened(service); const a = member('a'); const b = member('a', 'second');
    const first = await speaker(service, a); const second = await service.admit(b);
    await service.execute(a, { type: 'mic.acquire' }); shouldFail = true;
    await assert.rejects(service.execute(b, { type: 'mic.acquire' }), /media unavailable/);
    assert.equal(service.snapshot(owner).mediaSyncPending, true);
    assert.equal(service.mediaPolicy(first.identity)?.allowedSources.includes('microphone'), false);
    assert.equal(service.mediaPolicy(second.identity)?.allowedSources.includes('microphone'), false);
    shouldFail = false;
    await service.prune();
    assert.equal(service.snapshot(owner).mediaSyncPending, false);
    assert.equal(service.mediaPolicy(first.identity)?.allowedSources.includes('microphone'), false);
    assert.equal(service.mediaPolicy(second.identity)?.allowedSources.includes('microphone'), false, 'retrying revocation must not silently grant the failed handoff');
  } finally { service.close(); }
});

test('failed microphone block stays durably pending until maintenance confirms the restrictive policy', async () => {
  let shouldFail = false;
  const attempts: MediaPolicy[][] = [];
  const { service } = fixture({ media: { async reconcile(_room, policies) {
    attempts.push(structuredClone(policies));
    assert.equal(service.store.read<{ mediaSyncPending: boolean }>()?.mediaSyncPending, true, 'the retry obligation must be durable before the RPC');
    if (shouldFail) throw new Error('media unavailable');
  } } });
  try {
    await opened(service); const actor = member('a'); const admission = await speaker(service, actor);
    await service.execute(actor, { type: 'mic.acquire' });
    shouldFail = true;
    await assert.rejects(service.execute(owner, { type: 'member.microphone', userId: actor.userId, action: 'block' }), /media unavailable/);
    assert.equal(service.snapshot(owner).mediaSyncPending, true);
    assert.equal(service.snapshot(owner).participants.find(p => p.userId === actor.userId)?.microphoneBlocked, true);
    const count = attempts.length;
    await assert.rejects(service.prune(), /media unavailable/);
    assert.equal(attempts.length, count + 1);
    assert.equal(service.store.read<{ mediaSyncPending: boolean }>()?.mediaSyncPending, true);
    shouldFail = false;
    await service.prune();
    assert.equal(attempts.length, count + 2);
    assert.equal(attempts.at(-1)?.find(policy => policy.identity === admission.identity)?.allowedSources.includes('microphone'), false);
    assert.equal(service.snapshot(owner).mediaSyncPending, false);
    assert.equal(service.store.read<{ mediaSyncPending: boolean }>()?.mediaSyncPending, false);
    await service.prune();
    assert.equal(attempts.length, count + 2, 'completed policy reconciliation needs no repeated RPC');
  } finally { service.close(); }
});

for (const command of [{ type: 'room.mode', mode: 'stage' }, { type: 'group.microphone', action: 'audience' }] as const) {
  test(`maintenance retries a failed ${command.type} microphone restriction`, async () => {
    let shouldFail = false;
    const attempts: MediaPolicy[][] = [];
    const { service } = fixture({ media: { async reconcile(_room, policies) {
      attempts.push(structuredClone(policies));
      if (shouldFail) throw new Error('media unavailable');
    } } });
    try {
      await opened(service); const actor = member('audience'); const admission = await service.admit(actor);
      await service.execute(owner, { type: 'room.mode', mode: 'open' });
      await service.execute(actor, { type: 'mic.acquire' });
      assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('microphone'), true);
      shouldFail = true;
      await assert.rejects(service.execute(owner, command), /media unavailable/);
      assert.equal(service.snapshot(owner).mediaSyncPending, true);
      shouldFail = false;
      const count = attempts.length;
      await service.prune();
      assert.equal(attempts.length, count + 1);
      assert.equal(attempts.at(-1)?.find(policy => policy.identity === admission.identity)?.allowedSources.includes('microphone'), false);
      assert.equal(service.snapshot(owner).mediaSyncPending, false);
    } finally { service.close(); }
  });
}

test('four simultaneous share requests allocate three leases, one per account across devices', async () => {
  const { service } = fixture();
  try {
    await opened(service); const actors = ['a','b','c','d'].map(id => member(id));
    for (const actor of actors) await speaker(service, actor);
    const results = await Promise.allSettled(actors.map(actor => service.execute(actor, { type: 'share.reserve' })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(service.snapshot(owner).shares.length, 3);
    await service.admit(member('a', 'other-device'));
    await assert.rejects(service.execute(member('a', 'other-device'), { type: 'share.reserve' }), denied('account_already_sharing'));
  } finally { service.close(); }
});

test('expired reservations are denied first and cannot free capacity until media cleanup succeeds', async () => {
  let shouldFail = false;
  const { service, advance } = fixture({ media: { async reconcile() { if (shouldFail) throw new Error('revoke unavailable'); } } });
  try {
    await opened(service); const actors = ['a','b','c','d'].map(id => member(id));
    for (const actor of actors) await speaker(service, actor);
    for (const actor of actors.slice(0,3)) await service.execute(actor, { type: 'share.reserve' });
    advance(31); shouldFail = true;
    await assert.rejects(service.execute(actors[3], { type: 'share.reserve' }), /revoke unavailable/);
    assert.equal(service.listMediaPolicies().some(policy => policy.allowedSources.includes('screen_share')), false);
    shouldFail = false;
    const result = await service.execute(actors[3], { type: 'share.reserve' });
    assert.equal(result.snapshot.shares.length, 1);
    assert.equal(result.reservation?.userId, 'd');
  } finally { service.close(); }
});

test('microphone blocks preserve screen grants; admin share stop keeps stage membership; demotion clears spotlight', async () => {
  const { service } = fixture();
  try {
    await opened(service); const a = member('a'); const admission = await speaker(service, a);
    const reserved = await service.execute(a, { type: 'share.reserve' });
    await service.execute(a, { type: 'share.confirm', reservationId: reserved.reservation!.id });
    await service.execute(owner, { type: 'spotlight.set', reservationId: reserved.reservation!.id });
    await service.execute(owner, { type: 'member.microphone', userId: 'a', action: 'block' });
    assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('screen_share'), true);
    await service.execute(owner, { type: 'share.stop', userId: 'a' });
    assert.equal(service.snapshot(a).self.canShare, true);
    assert.equal(service.snapshot(owner).session?.spotlightReservationId, null);
    const again = await service.execute(a, { type: 'share.reserve' });
    await service.execute(a, { type: 'share.confirm', reservationId: again.reservation!.id });
    await service.execute(owner, { type: 'spotlight.set', reservationId: again.reservation!.id });
    await service.execute(owner, { type: 'member.stage', userId: 'a', onStage: false });
    assert.equal(service.snapshot(owner).shares.length, 0);
    assert.equal(service.snapshot(owner).session?.spotlightReservationId, null);
    assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('screen_share'), false);
  } finally { service.close(); }
});

test('chat and reactions derive identity from server actor and reject unknown mentions', async () => {
  const { service } = fixture();
  try {
    await opened(service); const a = member('a'); await service.admit(a);
    await service.execute(a, { type: 'chat.send', text: '<img src=x onerror=alert(1)> @Owner', mentionUserIds: ['owner'], userId: 'owner', displayName: 'Impersonated', clientId: 'same-message' });
    await service.execute(a, { type: 'chat.send', text: 'Duplicate delivery', clientId: 'same-message' });
    const chat = service.snapshot(a).messages[0];
    assert.equal(service.snapshot(a).messages.length, 1);
    assert.equal(chat.userId, 'a'); assert.equal(chat.displayName, 'Member a');
    assert.equal(chat.text, '<img src=x onerror=alert(1)> @Owner');
    assert.deepEqual(chat.mentions, [{ userId: 'owner', displayName: 'Owner' }]);
    await assert.rejects(service.execute(a, { type: 'chat.send', text: 'Hello', mentionUserIds: ['outsider'] }), denied('invalid_mentions'));
    await service.execute(a, { type: 'reaction.send', emoji: '🔥', userId: 'owner', clientId: 'reaction-1' });
    await service.execute(a, { type: 'reaction.send', emoji: '🔥', userId: 'owner', clientId: 'reaction-1' });
    assert.equal(service.snapshot(a).reactions.length, 1);
    assert.equal(service.snapshot(a).reactions[0].userId, 'a');
    await service.execute(a, { type: 'chat.react', messageId: chat.id, emoji: '👍', clientId: 'toggle-1' });
    await service.execute(a, { type: 'chat.react', messageId: chat.id, emoji: '👍', clientId: 'toggle-1' });
    assert.deepEqual(service.snapshot(a).messages[0].reactions['👍'], ['a']);
  } finally { service.close(); }
});

test('only admins pin, late joins receive current pins, and deletion removes pins without permanent message bodies', async () => {
  const { service } = fixture();
  try {
    await opened(service); const a = member('a'); await service.admit(a);
    const sent = await service.execute(a, { type: 'chat.send', text: 'SENSITIVE_CHAT_MARKER' }); const id = sent.snapshot.messages[0].id;
    await assert.rejects(service.execute(a, { type: 'chat.pin', messageId: id, pinned: true }), denied('admin_required'));
    await service.execute(owner, { type: 'chat.pin', messageId: id, pinned: true });
    await service.admit(member('b'));
    assert.equal(service.snapshot(member('b')).pins[0].messageId, id);
    assert.equal(service.snapshot(member('not-admitted')).pins.length, 0);
    assert.equal(service.snapshot(admin).messages.length, 0, 'admin authority alone does not expose live chat');
    await service.execute(owner, { type: 'chat.remove', messageId: id });
    assert.equal(service.snapshot(a).pins.length, 0); assert.equal(service.snapshot(a).messages.length, 0);
    assert.equal(JSON.stringify(service.snapshot(owner).audit).includes('SENSITIVE_CHAT_MARKER'), false);
    assert.equal(service.snapshot(owner).audit?.some(event => event.targetId === id), true);
  } finally { service.close(); }
});

test('removed users cannot use an old admission for chat, reactions, or pin operations', async () => {
  const { service } = fixture();
  try {
    await opened(service); const a = member('a'); const admission = await service.admit(a);
    await service.execute(owner, { type: 'member.remove', userId: 'a', action: 'session-block' });
    await assert.rejects(service.execute(a, { type: 'chat.send', text: 'Still here' }), denied('entry_blocked'));
    await assert.rejects(service.execute(a, { type: 'reaction.send', emoji: '👍' }), denied('entry_blocked'));
    assert.equal(service.mediaPolicy(admission.identity)?.active, false);
    assert.equal(service.snapshot(a).messages.length, 0);
  } finally { service.close(); }
});

test('process restart closes prior session, retains schedules/audit/ban, and blocks admission until media reconciliation', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'private-stage-domain-'));
  const databasePath = join(folder, 'stage.sqlite');
  let service: StageService | undefined;
  try {
    service = new StageService({ databasePath, ownerUserId: 'owner' });
    await opened(service); const old = await service.admit(member('a'));
    await service.execute(owner, { type: 'schedule.save', title: 'Future', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' });
    await service.execute(owner, { type: 'chat.send', text: 'Not retained across restart' });
    await service.execute(owner, { type: 'member.remove', userId: 'a', action: 'ban' });
    service.close(); service = undefined;
    const closedRooms: string[] = [];
    let failClose = true;
    service = new StageService({ databasePath, ownerUserId: 'owner', media: { async closeRoom(room) { if (failClose) throw new Error('media cleanup unavailable'); closedRooms.push(room); } } });
    assert.equal(service.snapshot(owner).session, null);
    assert.equal(service.snapshot(owner).messages.length, 0);
    assert.equal(service.snapshot(owner).schedules.length, 1);
    assert.equal(service.snapshot(owner).bans?.[0].userId, 'a');
    assert.ok(service.snapshot(owner).audit!.length >= 3);
    assert.equal(service.mediaPolicy(old.identity)?.active, false);
    assert.equal(service.snapshot(owner).mediaSyncPending, true);
    assert.equal(service.store.read<{ mediaSyncPending: boolean }>()?.mediaSyncPending, true);
    await assert.rejects(service.execute(owner, { type: 'session.open', mode: 'stage' }), denied('cleanup_pending'));
    await assert.rejects(service.startupClose(), /media cleanup unavailable/);
    await service.prune();
    assert.equal(service.snapshot(owner).mediaSyncPending, true, 'closed-room maintenance cannot acknowledge an unconfirmed SFU cleanup');
    failClose = false;
    await service.startupClose();
    assert.equal(closedRooms.length, 1);
    assert.equal(service.snapshot(owner).mediaSyncPending, false);
    await service.execute(owner, { type: 'session.open', mode: 'stage' });
    assert.notEqual(service.snapshot(owner).session?.id, old.sessionId);
    await assert.rejects(service.admit(member('a')), denied('entry_blocked'));
  } finally { service?.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('failed end closes application admission and retries media cleanup idempotently', async () => {
  let failClose = true;
  const { service } = fixture({ media: { async closeRoom() { if (failClose) throw new Error('cannot close media'); } } });
  try {
    await opened(service); const old = await service.admit(member('a'));
    await assert.rejects(service.execute(owner, { type: 'session.end' }), /cannot close media/);
    assert.equal(service.snapshot(owner).session, null);
    assert.equal(service.snapshot(owner).cleanupPending, true);
    assert.equal(service.snapshot(owner).mediaSyncPending, true);
    assert.equal(service.mediaPolicy(old.identity)?.active, false);
    await assert.rejects(service.execute(owner, { type: 'session.open', mode: 'stage' }), denied('cleanup_pending'));
    failClose = false;
    await service.execute(owner, { type: 'session.end' });
    assert.equal(service.snapshot(owner).cleanupPending, false);
    assert.equal(service.snapshot(owner).mediaSyncPending, false);
    await service.execute(owner, { type: 'session.open', mode: 'stage' });
  } finally { service.close(); }
});

test('environment role IDs initialize existing preview data until owner explicitly overrides them', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'private-stage-role-seed-'));
  const databasePath = join(folder, 'stage.sqlite');
  let service: StageService | undefined;
  try {
    service = new StageService({ databasePath, ownerUserId: 'owner', adminRoleIds: [] });
    service.close(); service = undefined;
    service = new StageService({ databasePath, ownerUserId: 'owner', adminRoleIds: ['discord-role'] });
    assert.deepEqual(service.getAdminConfiguration().adminRoleIds, ['discord-role']);
    await service.execute(owner, { type: 'admin.roles', roleIds: ['owner-saved-role'] });
    service.close(); service = undefined;
    service = new StageService({ databasePath, ownerUserId: 'owner', adminRoleIds: ['later-env-role'] });
    assert.deepEqual(service.getAdminConfiguration().adminRoleIds, ['owner-saved-role']);
  } finally { service?.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('trusted SFU unpublish releases the share and spotlight while preserving stage and microphone', async () => {
  const { service } = fixture();
  try {
    await opened(service); const a = member('a'); const admission = await speaker(service, a);
    await service.execute(a, { type: 'mic.acquire' });
    const reservation = (await service.execute(a, { type: 'share.reserve' })).reservation!;
    await service.execute(a, { type: 'share.confirm', reservationId: reservation.id });
    await service.execute(owner, { type: 'spotlight.set', reservationId: reservation.id });
    await service.releaseShareByIdentity(admission.identity);
    assert.equal(service.snapshot(a).shares.length, 0);
    assert.equal(service.snapshot(a).session?.spotlightReservationId, null);
    assert.equal(service.snapshot(a).self.canShare, true);
    assert.deepEqual(service.mediaPolicy(admission.identity)?.allowedSources, ['microphone']);
  } finally { service.close(); }
});

test('delayed SFU unpublish from an old reservation cannot clear a newer share on the same identity', async () => {
  const { service } = fixture();
  try {
    await opened(service); const a = member('a'); const admission = await speaker(service, a);
    const first = (await service.execute(a, { type: 'share.reserve' })).reservation!;
    await service.execute(a, { type: 'share.confirm', reservationId: first.id });
    await service.execute(a, { type: 'share.release' });
    const second = (await service.execute(a, { type: 'share.reserve' })).reservation!;
    await service.releaseShareByIdentity(admission.identity, first.id);
    assert.equal(service.snapshot(a).shares[0]?.id, second.id);
    assert.equal(service.mediaPolicy(admission.identity)?.shareReservationId, second.id);
  } finally { service.close(); }
});

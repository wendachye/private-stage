import test from 'node:test';
import assert from 'node:assert/strict';
import { StageService, DomainError } from '../backend/src/domain/stage-service.ts';
import type { Principal } from '../shared/types.ts';

const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'owner-device', isOwner: true, isAdmin: true };
const member = (userId: string, deviceId = userId + '-device'): Principal => ({ userId, deviceId, displayName: userId, isOwner: false, isAdmin: false });
const denied = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('new manual and scheduled waiting rooms default to Everyone while microphones remain off', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    for (const scheduled of [false, true]) {
      let scheduleId: string | undefined;
      if (scheduled) {
        const result = await service.execute(owner, { type: 'schedule.save', title: 'Default speaking mode', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' });
        scheduleId = result.snapshot.schedules[0]!.id;
      }
      const opened = await service.execute(owner, { type: 'session.open', ...(scheduleId ? { scheduleId } : {}) });
      assert.equal(opened.snapshot.session?.state, 'waiting');
      assert.equal(opened.snapshot.session?.mode, 'open');
      const audience = member('audience'); const admission = await service.admit(audience);
      assert.equal(service.snapshot(audience).self.canSpeak, true);
      assert.equal(service.snapshot(audience).self.microphoneOwned, false);
      assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('microphone'), false);
      await service.execute(owner, { type: 'session.start' });
      assert.equal(service.snapshot(audience).session?.mode, 'open');
      assert.equal(service.snapshot(audience).self.microphoneOwned, false);
      await service.execute(owner, { type: 'session.end' });
    }
  } finally { service.close(); }
});

test('each speaking mode works before and after Go live without expanding screen-sharing or automatically enabling microphones', async () => {
  for (const mode of ['stage', 'open', 'qa'] as const) {
    const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
    try {
      await service.execute(owner, { type: 'session.open', mode });
      const audience = member('audience');
      const admission = await service.admit(audience);
      for (const phase of ['waiting', 'live'] as const) {
        const state = service.snapshot(audience);
        assert.equal(state.session?.state, phase);
        assert.equal(state.session?.mode, mode);
        assert.equal(state.self.canSpeak, mode === 'open');
        assert.equal(state.self.canShare, false);
        assert.equal(state.self.microphoneOwned, false);
        assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('microphone'), false);
        await assert.rejects(service.execute(audience, { type: 'share.reserve' }), denied('stage_required'));
        await service.execute(audience, { type: 'chat.send', text: 'Chat in ' + phase, clientId: phase });
        if (phase === 'waiting') await service.execute(owner, { type: 'session.start' });
      }
      assert.equal(service.snapshot(audience).messages.length, 2);
    } finally { service.close(); }
  }
});

test('changing modes in either phase revokes audience device leases and retains individual and group restrictions', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'open' });
    const first = member('audience'), second = member('audience', 'second-device'), blocked = member('blocked');
    const aa = await service.admit(first), ab = await service.admit(second); await service.admit(blocked);
    await service.execute(owner, { type: 'member.microphone', userId: blocked.userId, action: 'block' });
    for (const phase of ['waiting', 'live'] as const) {
      await service.execute(owner, { type: 'room.mode', mode: 'open' });
      await service.execute(first, { type: 'mic.acquire' });
      await service.execute(second, { type: 'mic.acquire' });
      assert.equal(service.mediaPolicy(aa.identity)?.allowedSources.includes('microphone'), false);
      assert.equal(service.mediaPolicy(ab.identity)?.allowedSources.includes('microphone'), true);
      await service.execute(owner, { type: 'room.mode', mode: 'qa' });
      assert.equal(service.snapshot(first).self.microphoneOwned, false);
      assert.equal(service.snapshot(second).self.microphoneOwned, false);
      assert.equal(service.mediaPolicy(ab.identity)?.allowedSources.includes('microphone'), false);
      await service.execute(owner, { type: 'room.mode', mode: 'open' });
      assert.equal(service.snapshot(first).self.microphoneOwned, false, 'A relaxed mode cannot revive a previous microphone lease.');
      assert.equal(service.snapshot(blocked).self.canSpeak, false);
      await service.execute(owner, { type: 'group.microphone', action: 'audience' });
      assert.equal(service.snapshot(first).self.canSpeak, false);
      await service.execute(owner, { type: 'room.mode', mode: 'stage' });
      await service.execute(owner, { type: 'room.mode', mode: 'open' });
      assert.equal(service.snapshot(first).self.canSpeak, false, 'Changing mode cannot clear an admin group restriction.');
      await service.execute(owner, { type: 'group.microphone', action: 'allow' });
      assert.equal(service.snapshot(blocked).self.canSpeak, false);
      if (phase === 'waiting') await service.execute(owner, { type: 'session.start' });
    }
  } finally { service.close(); }
});

test('speaking mode validation and admin authority apply before mutation, and legacy waiting controls map to the same mode', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await assert.rejects(service.execute(owner, { type: 'session.open', mode: 'invalid' }), denied('invalid_mode'));
    assert.equal(service.snapshot(owner).session, null);
    await service.execute(owner, { type: 'session.open', mode: 'qa' });
    const audience = member('audience'); await service.admit(audience);
    for (const phase of ['waiting', 'live'] as const) {
      await assert.rejects(service.execute(audience, { type: 'room.mode', mode: 'open' }), denied('admin_required'));
      await assert.rejects(service.execute(owner, { type: 'room.mode', mode: 'invalid' }), denied('invalid_mode'));
      assert.equal(service.snapshot(owner).session?.mode, 'qa');
      if (phase === 'waiting') {
        await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
        assert.equal(service.snapshot(owner).session?.mode, 'open');
        assert.equal(service.snapshot(owner).session?.waitingAudienceCanSpeak, true);
        await service.execute(owner, { type: 'room.waiting-audio', enabled: false });
        assert.equal(service.snapshot(owner).session?.mode, 'stage');
        await service.execute(owner, { type: 'room.mode', mode: 'qa' });
        await service.execute(owner, { type: 'session.start' });
      }
    }
  } finally { service.close(); }
});

test('a failed restrictive media update keeps desired publication denied until retry succeeds', async () => {
  let fail = false;
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId,
    media: { async reconcile() { if (fail) throw new Error('Synthetic SFU restriction failure'); } },
  });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'open' });
    await service.execute(owner, { type: 'session.start' });
    const audience = member('audience'); const admission = await service.admit(audience);
    await service.execute(audience, { type: 'mic.acquire' });
    fail = true;
    await assert.rejects(service.execute(owner, { type: 'room.mode', mode: 'stage' }), /Synthetic SFU restriction failure/);
    assert.equal(service.snapshot(owner).session?.mode, 'stage');
    assert.equal(service.snapshot(owner).mediaSyncPending, true);
    assert.equal(service.snapshot(audience).self.microphoneOwned, false);
    assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('microphone'), false);
    await assert.rejects(service.execute(audience, { type: 'mic.acquire' }), denied('microphone_blocked'));
    fail = false;
    await service.execute(owner, { type: 'room.mode', mode: 'stage' });
    assert.equal(service.snapshot(owner).mediaSyncPending, false);
    assert.equal(service.snapshot(audience).self.microphoneOwned, false);
  } finally { service.close(); }
});

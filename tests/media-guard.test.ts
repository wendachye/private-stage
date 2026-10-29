import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicationGuard } from '../backend/src/media/guard.js';
import type { MediaPolicy, MediaSource } from '../shared/types.js';

const policy = (user: string, device = 'one', sources: MediaSource[] = ['microphone', 'screen_share', 'screen_share_audio']): MediaPolicy => ({
  identity: `${user}-${device}`, accountId: user, userId: user, deviceId: device,
  admissionId: `admit-${user}-${device}`, sessionId: 'session', roomName: 'room',
  displayName: user, active: true, allowedSources: sources,
});

test('four concurrent screen publication intents cannot reserve more than three room tracks', async () => {
  const guard = new PublicationGuard(3);
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map(async user => {
    await Promise.resolve();
    return guard.reserve(policy(user), { cid: `${user}-screen`, source: 'screen_share', kind: 'video' });
  }));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  assert.equal(guard.snapshot().filter(track => track.source === 'screen_share').length, 3);
});

test('one account cannot publish an extra screen from either the same device or a second device', () => {
  const guard = new PublicationGuard();
  guard.reserve(policy('alice'), { cid: 'first', source: 'screen_share', kind: 'video' });
  assert.throws(() => guard.reserve(policy('alice'), { cid: 'extra', source: 'screen_share', kind: 'video' }), /already has/);
  assert.throws(() => guard.reserve(policy('alice', 'two'), { cid: 'other', source: 'screen_share', kind: 'video' }), /already has/);
  // Screen audio is associated media, not a fourth video slot.
  guard.reserve(policy('alice'), { cid: 'audio', source: 'screen_share_audio', kind: 'audio' });
  assert.equal(guard.snapshot().filter(track => track.source === 'screen_share').length, 1);
});

test('microphone ownership is account-wide; an unconfirmed disconnect cannot release it', () => {
  const guard = new PublicationGuard();
  guard.reserve(policy('alice'), { cid: 'mic', source: 'microphone', kind: 'audio' });
  assert.throws(() => guard.reserve(policy('alice', 'two'), { cid: 'second', source: 'microphone', kind: 'audio' }), /already has/);
  guard.removeSources('alice-one', ['screen_share', 'screen_share_audio']);
  guard.reserve(policy('alice', 'two'), { cid: 'second', source: 'microphone', kind: 'audio' });
  assert.equal(guard.snapshot().length, 1);
});

test('permission revocation preserves permitted screen video/audio while denying the microphone', () => {
  const guard = new PublicationGuard();
  for (const [cid, source, kind] of [['mic', 'microphone', 'audio'], ['screen', 'screen_share', 'video'], ['system', 'screen_share_audio', 'audio']] as const) guard.reserve(policy('alice'), { cid, source, kind });
  guard.removeSources('alice-one', ['screen_share', 'screen_share_audio']);
  assert.deepEqual(guard.snapshot().map(track => track.source).sort(), ['screen_share', 'screen_share_audio']);
  assert.throws(() => guard.reserve(policy('alice', 'one', ['screen_share']), { cid: 'new-mic', source: 'microphone', kind: 'audio' }), /not permitted/);
});

test('reconnect may reference only previously confirmed CID/SID/source publications', () => {
  const guard = new PublicationGuard();
  guard.reserve(policy('alice'), { cid: 'screen', source: 'screen_share', kind: 'video' });
  guard.confirm('alice-one', 'screen', 'TR_one', 'screen_share');
  guard.assertSync('alice-one', [{ cid: 'screen', sid: 'TR_one', source: 'screen_share' }]);
  assert.throws(() => guard.assertSync('alice-one', [{ cid: 'injected', sid: 'TR_two', source: 'screen_share' }]), /unreserved/);
  assert.throws(() => guard.confirm('alice-one', 'unreserved', 'TR_extra', 'screen_share'), /unreserved/);
});

test('an additional codec aliases a confirmed publication without consuming another screen slot', () => {
  const guard = new PublicationGuard(1);
  guard.reserve(policy('alice'), { cid: 'screen', source: 'screen_share', kind: 'video' });
  guard.confirm('alice-one', 'screen', 'TR_one', 'screen_share');
  guard.reserve(policy('alice'), { cid: 'screen-backup-codec', sid: 'TR_one', source: 'screen_share', kind: 'video' });
  guard.confirm('alice-one', 'screen-backup-codec', 'TR_one', 'screen_share');
  assert.equal(guard.snapshot().length, 1);
  assert.throws(() => guard.reserve(policy('alice'), { cid: 'fake-audio-codec', sid: 'TR_one', source: 'microphone', kind: 'audio' }), /existing publication/);
});

test('pending expiry does not silently free a slot before SFU cleanup is confirmed', () => {
  let now = 0;
  const guard = new PublicationGuard(1, () => now);
  guard.reserve(policy('alice'), { cid: 'screen', source: 'screen_share', kind: 'video' });
  now = 31000;
  assert.deepEqual(guard.pendingExpired(30000), ['alice-one']);
  assert.throws(() => guard.reserve(policy('bob'), { cid: 'other', source: 'screen_share', kind: 'video' }), /occupied/);
  guard.removeIdentity('alice-one');
  guard.reserve(policy('bob'), { cid: 'other', source: 'screen_share', kind: 'video' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenCaptureController } from '../frontend/client/screen-capture-controller.ts';
import { StageService } from '../backend/src/domain/stage-service.ts';
import type { Principal } from '../shared/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
class CapturedTrack {
  stopped = 0;
  constructor(readonly source: 'screen_share' | 'screen_share_audio') {}
  stop() { this.stopped++; }
}
async function fixture() {
  const owner: Principal = { userId: 'capture-owner', displayName: 'Synthetic capture owner', deviceId: 'capture-device', isOwner: true, isAdmin: true };
  let now = Date.UTC(2026, 9, 29);
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId, now: () => now });
  await service.execute(owner, { type: 'session.open' });
  const admission = await service.admit(owner);
  const errors: unknown[] = [];
  let reserveCalls = 0, releaseCalls = 0;
  const published: CapturedTrack[] = [];
  const controller = new ScreenCaptureController<CapturedTrack>({
    scope: () => admission.id,
    allowed: scope => scope === admission.id && service.snapshot(owner).self.canShare,
    reserve: async () => {
      reserveCalls++;
      const result = await service.execute(owner, { type: 'share.reserve' });
      assert.ok(result.reservation);
      return result.reservation.reservationId;
    },
    confirm: async reservationId => { await service.execute(owner, { type: 'share.confirm', reservationId }); },
    release: async () => { releaseCalls++; await service.execute(owner, { type: 'share.release' }); },
    unpublish: async () => {},
    onEnded: () => {},
    changed: () => {},
    failed: reason => errors.push(reason),
  });
  const publish = async (track: CapturedTrack) => {
    assert.ok(service.mediaPolicy(admission.identity)?.allowedSources.includes(track.source),
      `The selected ${track.source} cannot publish because its screen reservation expired while the native picker was open.`);
    published.push(track);
  };
  return { service, owner, controller, publish, errors, published,
    advanceBeyondReservation() { now += (service.policy.shareReservationSeconds + 1) * 1000; },
    reserveCalls: () => reserveCalls, releaseCalls: () => releaseCalls,
  };
}

test('a screen selected after a long native picker publishes and confirms with a current domain lease', async () => {
  const f = await fixture(), picker = deferred<CapturedTrack[]>();
  let pickers = 0;
  const started = f.controller.start(() => { pickers++; return picker.promise; }, f.publish);
  try {
    assert.equal(pickers, 1, 'Capture must begin synchronously in the original user gesture.');
    await settle();
    f.advanceBeyondReservation();
    const video = new CapturedTrack('screen_share'), audio = new CapturedTrack('screen_share_audio');
    picker.resolve([video, audio]);
    assert.equal(await started, true, f.errors.map(reason => reason instanceof Error ? reason.message : String(reason)).join('\n'));
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.published, [video, audio]);
    assert.equal(f.controller.active, true);
    assert.equal(f.service.snapshot(f.owner).shares[0]?.status, 'active');
  } finally {
    picker.resolve([]);
    await started;
    await f.controller.stop();
    f.service.close();
  }
});

test('cancel while choosing uses no screen lease, completes before the picker, and stops late captured tracks', async () => {
  const f = await fixture(), picker = deferred<CapturedTrack[]>();
  const started = f.controller.start(() => picker.promise, f.publish);
  await settle();
  let cancelled = false;
  const cancellation = f.controller.stop().then(() => { cancelled = true; });
  try {
    await settle();
    assert.equal(cancelled, true, 'Cancel must finish without waiting for the unresolved browser chooser.');
    const video = new CapturedTrack('screen_share'), audio = new CapturedTrack('screen_share_audio');
    picker.resolve([video, audio]);
    assert.equal(await started, false);
    await cancellation;
    assert.equal(f.reserveCalls(), 0);
    assert.equal(f.releaseCalls(), 0);
    assert.equal(f.service.snapshot(f.owner).shares.length, 0);
    assert.deepEqual(f.published, []);
    assert.ok(video.stopped > 0 && audio.stopped > 0);
    assert.deepEqual(f.errors, []);
  } finally {
    picker.resolve([]);
    await started;
    await cancellation;
    await f.controller.stop();
    f.service.close();
  }
});

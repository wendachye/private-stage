import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenCaptureController } from '../frontend/client/screen-capture-controller.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
class FakeTrack {
  stopped = 0;
  ended?: () => void;
  constructor(readonly id: string) {}
  stop() { this.stopped++; }
}
function fixture(options: { reserve?: () => Promise<string>; publish?: (track: FakeTrack) => Promise<void> } = {}) {
  let scope: string | null = 'admission-a', allowed = true;
  const calls: string[] = [], errors: unknown[] = [], phases: Array<{ pending: boolean; active: boolean }> = [];
  let reservations = 0;
  const controller = new ScreenCaptureController<FakeTrack>({
    scope: () => scope,
    allowed: candidate => allowed && scope === candidate,
    reserve: () => { calls.push('reserve'); return options.reserve?.() ?? Promise.resolve(`reservation-${++reservations}`); },
    confirm: async id => { calls.push(`confirm:${id}`); },
    release: async () => { calls.push('release'); },
    unpublish: async track => { calls.push(`unpublish:${track.id}`); },
    onEnded: (tracks, ended) => { tracks[0].ended = ended; },
    changed: value => phases.push(value),
    failed: error => errors.push(error),
  });
  const publish = async (track: FakeTrack) => { calls.push(`publish:${track.id}`); await options.publish?.(track); };
  return { controller, calls, errors, phases, publish,
    setScope(value: string | null) { scope = value; },
    deny() { allowed = false; controller.reconcile(); },
  };
}

test('screen capture begins in the click turn and duplicate starts share one operation', async () => {
  const pending = deferred<FakeTrack[]>(), f = fixture();
  const screen = new FakeTrack('screen'), audio = new FakeTrack('audio');
  let pickers = 0;
  const start = f.controller.start(() => { pickers++; f.calls.push('capture'); return pending.promise; }, f.publish);
  assert.deepEqual(f.calls, ['capture']);
  await f.controller.start(() => { pickers++; return Promise.resolve([]); }, f.publish);
  assert.equal(pickers, 1);
  pending.resolve([screen, audio]);
  await start;
  assert.deepEqual(f.calls, ['capture', 'reserve', 'publish:screen', 'publish:audio', 'confirm:reservation-1']);
  assert.equal(f.controller.active, true);
  assert.equal(f.controller.pending, false);
});

test('denied picker reports its error without acquiring or releasing a screen slot', async () => {
  const denied = new Error('permission denied');
  const f = fixture();
  const start = f.controller.start(() => Promise.reject(denied), f.publish);
  await start;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.errors, [denied]);
  assert.equal(f.controller.pending, false);
});

test('quota refusal after screen selection stops captured tracks without publication', async () => {
  const picker = deferred<FakeTrack[]>(), failure = new Error('all screen slots occupied');
  const f = fixture({ reserve: () => Promise.reject(failure) });
  const start = f.controller.start(() => picker.promise, f.publish);
  await settle();
  assert.deepEqual(f.calls, [], 'The unresolved native chooser must not acquire quota.');
  const screen = new FakeTrack('screen');
  picker.resolve([screen]);
  await start;
  assert.ok(screen.stopped > 0);
  assert.deepEqual(f.calls, ['reserve', 'unpublish:screen']);
  assert.deepEqual(f.errors, [failure]);
});

test('leaving during the picker stops late tracks without releasing a replacement share', async () => {
  const picker = deferred<FakeTrack[]>(), f = fixture();
  const oldStart = f.controller.start(() => picker.promise, f.publish);
  await settle();
  await f.controller.stop();
  const replacement = new FakeTrack('replacement');
  await f.controller.start(() => Promise.resolve([replacement]), f.publish);
  const old = new FakeTrack('old');
  picker.resolve([old]);
  await oldStart;
  assert.ok(old.stopped > 0);
  assert.equal(replacement.stopped, 0);
  assert.equal(f.controller.active, true);
  assert.equal(f.calls.filter(value => value === 'release').length, 0);
  assert.equal(f.calls.includes('publish:old'), false);
});

test('a cancelled capture cannot report a replacement attempt as its own success', async () => {
  const picker = deferred<FakeTrack[]>(), f = fixture();
  const oldStart = f.controller.start(() => picker.promise, f.publish);
  await settle();
  await f.controller.stop();
  const replacement = await f.controller.start(() => Promise.resolve([new FakeTrack('replacement')]), f.publish);
  picker.resolve([new FakeTrack('old')]);
  assert.equal(await oldStart, false);
  assert.equal(replacement, true);
  assert.equal(f.controller.active, true);
});

test('demotion while choosing a screen cancels locally before acquiring a screen slot', async () => {
  const picker = deferred<FakeTrack[]>(), f = fixture();
  const start = f.controller.start(() => picker.promise, f.publish);
  await settle();
  f.deny();
  const screen = new FakeTrack('screen');
  picker.resolve([screen]);
  await start;
  assert.ok(screen.stopped > 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.errors, []);
});

test('old admission cleanup never sends its unscoped release into a new session', async () => {
  const picker = deferred<FakeTrack[]>(), f = fixture();
  const start = f.controller.start(() => picker.promise, f.publish);
  await settle();
  f.setScope('admission-b');
  f.controller.reconcile();
  await settle();
  const replacement = new FakeTrack('replacement');
  await f.controller.start(() => Promise.resolve([replacement]), f.publish);
  picker.resolve([new FakeTrack('old')]);
  await start;
  assert.equal(f.calls.includes('release'), false);
  assert.equal(f.controller.active, true);
  assert.equal(replacement.stopped, 0);
});

test('stop during publication stops collection immediately and waits for unpublish before reuse', async () => {
  const publication = deferred<void>(), f = fixture({ publish: () => publication.promise });
  const screen = new FakeTrack('screen');
  const start = f.controller.start(() => Promise.resolve([screen]), f.publish);
  await settle();
  const stop = f.controller.stop();
  assert.ok(screen.stopped > 0);
  let replacementPickers = 0;
  await f.controller.start(() => { replacementPickers++; return Promise.resolve([]); }, f.publish);
  assert.equal(replacementPickers, 0);
  assert.equal(f.calls.includes('release'), false);
  publication.resolve();
  await Promise.all([start, stop]);
  assert.deepEqual(f.calls, ['reserve', 'publish:screen', 'unpublish:screen', 'release']);
  assert.equal(f.controller.pending, false);
});

test('a delayed old browser ended event cannot stop a replacement capture', async () => {
  const f = fixture(), first = new FakeTrack('first'), second = new FakeTrack('second');
  await f.controller.start(() => Promise.resolve([first]), f.publish);
  const oldEnded = first.ended!;
  await f.controller.stop();
  await f.controller.start(() => Promise.resolve([second]), f.publish);
  oldEnded();
  await settle();
  assert.equal(f.controller.active, true);
  assert.equal(second.stopped, 0);
  assert.equal(f.calls.filter(value => value === 'release').length, 1);
  second.ended!();
  await settle();
  assert.equal(f.controller.active, false);
  assert.equal(f.calls.filter(value => value === 'release').length, 2);
});

test('browser Stop Sharing before reservation acknowledgement cancels before publication', async () => {
  const reserve = deferred<string>(), f = fixture({ reserve: () => reserve.promise });
  const screen = new FakeTrack('screen');
  const start = f.controller.start(() => Promise.resolve([screen]), f.publish);
  await settle();
  screen.ended!();
  assert.ok(screen.stopped > 0);
  reserve.resolve('late-reservation');
  await start;
  assert.deepEqual(f.calls, ['reserve', 'unpublish:screen', 'release']);
  assert.deepEqual(f.errors, []);
});

test('partial publication failure stops and unpublishes every captured track before releasing', async () => {
  const failure = new Error('audio publication failed');
  const f = fixture({ publish: async track => { if (track.id === 'audio') throw failure; } });
  const video = new FakeTrack('video'), audio = new FakeTrack('audio');
  await f.controller.start(() => Promise.resolve([video, audio]), f.publish);
  assert.ok(video.stopped > 0 && audio.stopped > 0);
  assert.deepEqual(f.calls, ['reserve', 'publish:video', 'publish:audio', 'unpublish:video', 'unpublish:audio', 'release']);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.controller.active, false);
});

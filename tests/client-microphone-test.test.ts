import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrophoneTestController, createMicrophoneMeter, type MicrophoneTestPhase } from '../frontend/client/microphone-test-controller.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stream() {
  const tracks = [{ stopped: 0, stop() { this.stopped++; } }];
  return { getTracks: () => tracks, tracks };
}
function fixture() {
  const phases: MicrophoneTestPhase[] = [], errors: unknown[] = [];
  const controller = new MicrophoneTestController<ReturnType<typeof stream>>(phase => phases.push(phase), error => errors.push(error));
  return { controller, phases, errors };
}

test('cancelling a pending local microphone test stops late permission without starting a meter', async () => {
  const pending = deferred<ReturnType<typeof stream>>(), f = fixture();
  let captures = 0, meters = 0;
  const start = f.controller.start(() => { captures++; return pending.promise; }, () => { meters++; return () => undefined; });
  await f.controller.start(() => { captures++; return Promise.resolve(stream()); }, () => () => undefined);
  assert.equal(captures, 1);
  f.controller.stop();
  const late = stream();
  pending.resolve(late);
  await start;
  assert.equal(meters, 0);
  assert.equal(late.tracks[0].stopped, 1);
  assert.deepEqual(f.phases, ['pending', 'idle']);
  assert.deepEqual(f.errors, []);
});

test('a cancelled old permission result cannot stop or change a replacement device test', async () => {
  const pending = deferred<ReturnType<typeof stream>>(), f = fixture();
  let disposed = 0;
  const old = f.controller.start(() => pending.promise, () => () => { disposed++; });
  f.controller.stop();
  const current = stream();
  await f.controller.start(() => Promise.resolve(current), () => () => { disposed++; });
  const late = stream();
  pending.resolve(late);
  await old;
  assert.equal(late.tracks[0].stopped, 1);
  assert.equal(current.tracks[0].stopped, 0);
  assert.equal(disposed, 0);
  assert.equal(f.controller.running, true);
  assert.equal(f.phases.at(-1), 'active');
  f.controller.stop();
  assert.equal(current.tracks[0].stopped, 1);
  assert.equal(disposed, 1);
});

test('late denial from a cancelled prompt does not report an error into the replacement test', async () => {
  const pending = deferred<ReturnType<typeof stream>>(), f = fixture();
  const old = f.controller.start(() => pending.promise, () => () => undefined);
  f.controller.stop();
  await f.controller.start(() => Promise.resolve(stream()), () => () => undefined);
  pending.reject(new Error('old permission denied'));
  await old;
  assert.deepEqual(f.errors, []);
  assert.equal(f.controller.running, true);
  f.controller.stop();
});

test('AudioContext construction failure releases the already granted microphone stream', async () => {
  const f = fixture(), capture = stream(), failure = new Error('AudioContext unavailable');
  await f.controller.start(() => Promise.resolve(capture), value => createMicrophoneMeter(value as unknown as MediaStream, () => undefined, {
    createAudio: () => { throw failure; }, frame: () => 0, cancel: () => undefined,
  }));
  assert.equal(capture.tracks[0].stopped, 1);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.phases.at(-1), 'idle');
});

for (const failureAt of ['analyser', 'source'] as const) {
  test(`partial ${failureAt} setup failure closes its AudioContext and releases capture`, async () => {
    const f = fixture(), capture = stream(), failure = new Error(`${failureAt} failed`);
    let closed = 0;
    const audio = {
      createAnalyser() { if (failureAt === 'analyser') throw failure; return { fftSize: 0, frequencyBinCount: 8 }; },
      createMediaStreamSource() { throw failure; },
      async close() { closed++; },
    } as unknown as AudioContext;
    await f.controller.start(() => Promise.resolve(capture), value => createMicrophoneMeter(value as unknown as MediaStream, () => undefined, {
      createAudio: () => audio, frame: () => 0, cancel: () => undefined,
    }));
    assert.equal(closed, 1);
    assert.equal(capture.tracks[0].stopped, 1);
    assert.deepEqual(f.errors, [failure]);
    assert.equal(f.controller.running, false);
  });
}

test('stopping an active meter cancels animation, closes once, and prevents queued updates', async () => {
  const f = fixture(), capture = stream();
  let closed = 0, nextFrame: FrameRequestCallback | undefined;
  const levels: number[] = [], cancelled: number[] = [];
  const audio = {
    createAnalyser() { return { fftSize: 0, frequencyBinCount: 8, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }; },
    createMediaStreamSource() { return { connect() {} }; },
    async close() { closed++; },
  } as unknown as AudioContext;
  await f.controller.start(() => Promise.resolve(capture), value => createMicrophoneMeter(value as unknown as MediaStream, level => levels.push(level), {
    createAudio: () => audio, frame: callback => { nextFrame = callback; return 7; }, cancel: id => cancelled.push(id),
  }));
  assert.deepEqual(levels, [0]);
  f.controller.stop();
  f.controller.stop();
  nextFrame!(0);
  assert.deepEqual(levels, [0]);
  assert.deepEqual(cancelled, [7]);
  assert.equal(closed, 1);
  assert.equal(capture.tracks[0].stopped, 1);
});

test('a meter read failure releases capture and reports the failure instead of leaving collection active', async () => {
  const f = fixture(), capture = stream(), failure = new Error('meter failed');
  let closed = 0;
  const failures: unknown[] = [];
  const audio = {
    createAnalyser() { return { fftSize: 0, frequencyBinCount: 8, getByteTimeDomainData() { throw failure; } }; },
    createMediaStreamSource() { return { connect() {} }; },
    async close() { closed++; },
  } as unknown as AudioContext;
  await f.controller.start(() => Promise.resolve(capture), value => createMicrophoneMeter(value as unknown as MediaStream, () => undefined, {
    createAudio: () => audio, frame: () => 0, cancel: () => undefined,
  }, error => { failures.push(error); f.controller.stop(); }));
  assert.ok(capture.tracks[0].stopped > 0);
  assert.equal(closed, 1);
  assert.deepEqual(failures, [failure]);
  assert.equal(f.controller.running, false);
});

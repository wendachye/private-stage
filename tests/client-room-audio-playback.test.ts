import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionState, RemoteAudioTrack, Room, RoomEvent, TrackEvent } from 'livekit-client';
import { RoomAudioPlaybackObserver } from '../frontend/client/room-audio-playback.ts';

const denied = () => new DOMException('play() failed because the user did not interact', 'NotAllowedError');
const audio = (id = 'remote-audio') => new RemoteAudioTrack({ id } as MediaStreamTrack, id, {} as RTCRtpReceiver);
function fixture() {
  const room = new Room();
  room.state = ConnectionState.Connected;
  let scope: string | null = 'admission-a', enabled = false;
  const observer = new RoomAudioPlaybackObserver(room, () => room.state === ConnectionState.Disconnected ? null : scope, value => { enabled = value; });
  observer.start();
  return { room, observer, get enabled() { return enabled; }, setScope(value: string | null) { scope = value; },
    subscribe(track: RemoteAudioTrack) { room.emit(RoomEvent.TrackSubscribed, track, {} as never, {} as never); },
    unsubscribe(track: RemoteAudioTrack) { room.emit(RoomEvent.TrackUnsubscribed, track, {} as never, {} as never); },
  };
}

// SDK events and real Room.startAudio are exercised here. Only the native
// element boundary is controlled; the parent acceptance uses actual Chrome.
function attach(room: Room, track: RemoteAudioTrack, play: () => Promise<void>) {
  const element = { paused: true, ended: false, readyState: 4, muted: false, play };
  track.attachedElements.push(element as HTMLMediaElement);
  room.remoteParticipants.set(track.sid!, { audioTrackPublications: new Map([[track.sid, { track }]]) } as never);
  return element;
}

test('a room success after a concrete track autoplay denial keeps Enable room audio available', () => {
  const room = new Room();
  const track = new RemoteAudioTrack({ id: 'remote-audio' } as MediaStreamTrack, 'audio-sid', {} as RTCRtpReceiver);
  let enabled = false;
  const observer = new RoomAudioPlaybackObserver(room, () => 'admission-a', value => { enabled = value; });
  observer.start();
  try {
    room.emit(RoomEvent.TrackSubscribed, track, {} as never, {} as never);
    room.emit(RoomEvent.AudioPlaybackStatusChanged, false);
    track.emit(TrackEvent.AudioPlaybackFailed, new DOMException('play() failed because the user did not interact', 'NotAllowedError'));
    // Captured Chrome sequence: an in-flight Room.startAudio() had snapshotted
    // no elements, then marked the SDK room true after the actual track failed.
    room.emit(RoomEvent.AudioPlaybackStatusChanged, true);
    assert.equal(enabled, false, 'A room-level success must not hide recovery for a failed remote audio track.');
  } finally { observer.stop(); }
});

test('room success and one playing track cannot clear another blocked audio track', () => {
  const f = fixture(), first = audio('first'), second = audio('second');
  try {
    f.subscribe(first); f.subscribe(second);
    first.emit(TrackEvent.AudioPlaybackFailed, denied());
    second.emit(TrackEvent.AudioPlaybackFailed, denied());
    f.room.emit(RoomEvent.AudioPlaybackStatusChanged, true);
    first.emit(TrackEvent.AudioPlaybackStarted);
    assert.equal(f.enabled, false);
    second.emit(TrackEvent.AudioPlaybackStarted);
    assert.equal(f.enabled, true);
  } finally { f.observer.stop(); }
});

test('the installed SDK direct-play recovery clears a failure without emitting track success', async () => {
  const f = fixture(), track = audio();
  let plays = 0, trackSuccesses = 0;
  const element = attach(f.room, track, async () => { plays++; element.paused = false; });
  f.subscribe(track);
  track.on(TrackEvent.AudioPlaybackStarted, () => { trackSuccesses++; });
  track.emit(TrackEvent.AudioPlaybackFailed, denied());
  try {
    assert.equal(f.enabled, false);
    await f.observer.startAudio();
    assert.equal(plays, 1);
    assert.equal(trackSuccesses, 0, 'The installed Room.startAudio only emits room success.');
    assert.equal(f.enabled, true);
  } finally { f.observer.stop(); }
});

test('an already attached paused remote track is observed when the listener starts', () => {
  const room = new Room(), track = audio();
  attach(room, track, async () => undefined);
  let enabled = true;
  const observer = new RoomAudioPlaybackObserver(room, () => 'admission-a', value => { enabled = value; });
  observer.start();
  try {
    assert.equal(enabled, false);
    track.emit(TrackEvent.AudioPlaybackStarted);
    assert.equal(enabled, true);
  } finally { observer.stop(); }
});

test('unsubscribe removes the failed track and its delayed callbacks cannot affect a replacement', () => {
  const f = fixture(), old = audio(), replacement = audio('replacement');
  f.subscribe(old);
  old.emit(TrackEvent.AudioPlaybackFailed, denied());
  const lateSuccess = old.listeners(TrackEvent.AudioPlaybackStarted)[0] as () => void;
  const lateFailure = old.listeners(TrackEvent.AudioPlaybackFailed)[0] as () => void;
  try {
    f.unsubscribe(old);
    assert.equal(f.enabled, true);
    assert.equal(old.listenerCount(TrackEvent.AudioPlaybackStarted), 0);
    assert.equal(old.listenerCount(TrackEvent.AudioPlaybackFailed), 0);
    f.subscribe(replacement);
    replacement.emit(TrackEvent.AudioPlaybackFailed, denied());
    lateSuccess(); lateFailure();
    assert.equal(f.enabled, false);
    replacement.emit(TrackEvent.AudioPlaybackStarted);
    assert.equal(f.enabled, true);
  } finally { f.observer.stop(); }
});

test('a new failure after a retry began cannot be erased by that older successful retry', async () => {
  const f = fixture(), track = audio();
  let finish!: () => void;
  const element = attach(f.room, track, () => new Promise<void>(resolve => { finish = resolve; }));
  f.subscribe(track);
  track.emit(TrackEvent.AudioPlaybackFailed, denied());
  try {
    const pending = f.observer.startAudio();
    track.emit(TrackEvent.AudioPlaybackFailed, denied());
    element.paused = false; finish();
    await pending;
    assert.equal(f.enabled, false);
  } finally { f.observer.stop(); }
});

test('retry success with a detached or replaced element does not claim that track recovered', async () => {
  for (const replacement of [false, true]) {
    const f = fixture(), track = audio();
    let finish!: () => void;
    const element = attach(f.room, track, () => new Promise<void>(resolve => { finish = resolve; }));
    f.subscribe(track);
    track.emit(TrackEvent.AudioPlaybackFailed, denied());
    try {
      const pending = f.observer.startAudio();
      track.attachedElements.length = 0;
      if (replacement) track.attachedElements.push({ paused: false, ended: false } as HTMLMediaElement);
      element.paused = false; finish();
      await pending;
      assert.equal(f.enabled, false);
    } finally { f.observer.stop(); }
  }
});

test('leave, admission replacement and reconnect invalidate old track callbacks and retry completion', async () => {
  for (const transition of ['leave', 'admission', 'reconnect'] as const) {
    const f = fixture(), old = audio(), replacement = audio('replacement');
    let finish!: () => void;
    const element = attach(f.room, old, () => new Promise<void>(resolve => { finish = resolve; }));
    f.subscribe(old);
    old.emit(TrackEvent.AudioPlaybackFailed, denied());
    const lateSuccess = old.listeners(TrackEvent.AudioPlaybackStarted)[0] as () => void;
    const lateFailure = old.listeners(TrackEvent.AudioPlaybackFailed)[0] as () => void;
    try {
      const pending = f.observer.startAudio();
      f.room.remoteParticipants.clear();
      f.setScope(transition === 'admission' ? 'admission-b' : null);
      f.room.state = ConnectionState.Disconnected;
      f.room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Disconnected);
      assert.equal(f.enabled, false);
      assert.equal(old.listenerCount(TrackEvent.AudioPlaybackFailed), 0);
      if (transition !== 'leave') {
        f.setScope(transition === 'admission' ? 'admission-b' : 'admission-a');
        f.room.state = ConnectionState.Connected;
        f.room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
        f.subscribe(replacement);
        replacement.emit(TrackEvent.AudioPlaybackFailed, denied());
      }
      lateSuccess(); lateFailure(); element.paused = false; finish();
      await pending;
      assert.equal(f.enabled, false);
    } finally { f.observer.stop(); }
  }
});

test('stop removes room and track listeners and does not accept a delayed native retry', async () => {
  const f = fixture(), track = audio();
  let finish!: () => void;
  const element = attach(f.room, track, () => new Promise<void>(resolve => { finish = resolve; }));
  f.subscribe(track);
  track.emit(TrackEvent.AudioPlaybackFailed, denied());
  const pending = f.observer.startAudio();
  const events = [RoomEvent.AudioPlaybackStatusChanged, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.ConnectionStateChanged];
  const before = events.map(event => f.room.listenerCount(event));
  f.observer.stop();
  assert.deepEqual(events.map(event => f.room.listenerCount(event)), before.map(count => count - 1));
  assert.equal(track.listenerCount(TrackEvent.AudioPlaybackFailed), 0);
  element.paused = false; finish(); await pending;
  assert.equal(f.enabled, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ConnectionState, Track } from 'livekit-client';
import { useStageMedia } from '../frontend/client/media.tsx';
import { StageService } from '../backend/src/domain/stage-service.ts';
import type { Command, Principal } from '../shared/types.ts';

async function withMedia(run: (media: ReturnType<typeof useStageMedia>, notifications: string[], commands: Command[]) => Promise<void>) {
  const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'browser', isOwner: true, isAdmin: true };
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  let media: ReturnType<typeof useStageMedia> | undefined;
  try {
    await service.execute(owner, { type: 'session.open' });
    const state = service.snapshot(owner);
    const notifications: string[] = [];
    const commands: Command[] = [];
    function Probe() {
      media = useStageMedia(state, value => { commands.push(value); return service.execute(owner, value); }, true, message => notifications.push(message));
      return null;
    }
    renderToString(createElement(Probe));
    assert.ok(media);
    await run(media, notifications, commands);
  } finally {
    // Publications below are synthetic SDK boundaries, never physical media.
    media?.room.localParticipant.audioTrackPublications.clear();
    await media?.room.disconnect(); service.close();
  }
}

test('the settings input-device action switches an enabled SDK microphone instead of only changing its label', async () => {
  await withMedia(async (media, notifications) => {
    const switched: Array<[MediaDeviceKind, string]> = [];
    let enabled = 0;
    Object.defineProperty(media.room.localParticipant, 'isMicrophoneEnabled', { configurable: true, get: () => true });
    media.room.switchActiveDevice = async (kind, id) => { switched.push([kind, id]); return true; };
    media.room.localParticipant.setMicrophoneEnabled = async () => { enabled++; throw new Error('Selecting a device must not toggle the microphone.'); };
    await media.setDeviceId('usb-microphone');
    assert.deepEqual(switched, [['audioinput', 'usb-microphone']]);
    assert.equal(enabled, 0);
    assert.deepEqual(notifications, []);
  });
});

test('selecting an input before publishing changes only SDK capture defaults and never enables a microphone', async () => {
  await withMedia(async media => {
    let enables = 0;
    media.room.localParticipant.setMicrophoneEnabled = async () => { enables++; return undefined; };
    // Exercise the installed SDK's real no-track switch path, not a fake switch.
    await media.setDeviceId('preferred-input');
    assert.equal(media.room.getActiveDevice('audioinput'), 'preferred-input');
    assert.equal(media.room.localParticipant.audioTrackPublications.size, 0);
    assert.equal(enables, 0);
  });
});

test('selecting an input for an existing muted publication updates its next-unmute constraints without enabling it', async () => {
  await withMedia(async media => {
    const constraints: unknown[] = [];
    let enables = 0;
    media.room.localParticipant.audioTrackPublications.set('synthetic-mic', {
      source: Track.Source.Microphone,
      audioTrack: { setDeviceId: async (constraint: unknown) => { constraints.push(constraint); return true; } },
      track: { isMuted: true },
    } as never);
    media.room.state = ConnectionState.Connected;
    media.room.localParticipant.setMicrophoneEnabled = async () => { enables++; return undefined; };
    // The real SDK delegates to the muted track's constraint setter. LiveKit's
    // LocalTrack.setDeviceId keeps that track muted and defers capture to Unmute.
    await media.setDeviceId('muted-preference');
    assert.deepEqual(constraints, [{ exact: 'muted-preference' }]);
    assert.equal(media.room.getActiveDevice('audioinput'), 'muted-preference');
    assert.equal(enables, 0);
    media.room.state = ConnectionState.Disconnected;
  });
});

test('a failed SDK input change rejects for the settings error pane and does not grant or enable a microphone', async () => {
  await withMedia(async (media, notifications, commands) => {
    media.room.switchActiveDevice = async () => false;
    await assert.rejects(media.setDeviceId('missing-input'), /could not be switched/);
    const failure = new Error('Requested input was disconnected.');
    media.room.switchActiveDevice = async () => { throw failure; };
    await assert.rejects(media.setDeviceId('missing-input'), error => error === failure);
    assert.equal(media.deviceId, 'default');
    assert.equal(commands.length, 0);
    assert.deepEqual(notifications, []);
  });
});

test('a pending input switch serializes other input changes and microphone toggles', async () => {
  await withMedia(async (media, _notifications, commands) => {
    let finish!: (success: boolean) => void;
    const switched: string[] = [];
    media.room.switchActiveDevice = async (_kind, id) => {
      switched.push(id); return new Promise<boolean>(resolve => { finish = resolve; });
    };
    const first = media.setDeviceId('first-input');
    await media.setDeviceId('second-input');
    await media.toggleMic();
    assert.deepEqual(switched, ['first-input']);
    assert.equal(commands.length, 0);
    finish(true); await first;
    media.room.switchActiveDevice = async (_kind, id) => { switched.push(id); return true; };
    await media.setDeviceId('second-input');
    assert.deepEqual(switched, ['first-input', 'second-input']);
  });
});

test('leaving during an input switch stops its late old microphone track without updating a replacement room', async () => {
  await withMedia(async (media, notifications, commands) => {
    let stops = 0, finish!: (success: boolean) => void;
    media.room.localParticipant.audioTrackPublications.set('synthetic-mic', {
      source: Track.Source.Microphone,
      audioTrack: { stop: () => { stops++; } },
    } as never);
    media.room.state = ConnectionState.Connected;
    media.room.switchActiveDevice = () => new Promise<boolean>(resolve => { finish = resolve; });
    media.room.disconnect = async () => { media.room.state = ConnectionState.Disconnected; };
    const switching = media.setDeviceId('late-input');
    await media.leave();
    finish(true); await switching;
    assert.equal(stops, 1);
    assert.deepEqual(commands.map(value => value.type), ['room.leave']);
    assert.deepEqual(notifications, []);
    assert.equal(media.deviceId, 'default');
  });
});

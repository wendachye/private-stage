import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { RoomServiceClient } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { StageService } from '../backend/src/domain/stage-service.ts';
import { createMediaController } from '../backend/src/media/controller.ts';
import type { Principal } from '../shared/types.ts';

const enabled = process.env.RUN_LIVEKIT_INTEGRATION === '1';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await wait(100); }
  throw new Error(message);
}

test('real SFU preserves Everyone microphone on Go live and revokes it on an explicit restrictive mode', {
  skip: enabled ? false : 'Set RUN_LIVEKIT_INTEGRATION=1 with the local LiveKit container running.', timeout: 45000,
}, async t => {
  const rtc = await import('@livekit/rtc-node');
  const livekitUrl = process.env.LIVEKIT_INTERNAL_URL ?? 'http://127.0.0.1:7880';
  const apiKey = process.env.LIVEKIT_API_KEY!, apiSecret = process.env.LIVEKIT_API_SECRET!;
  assert.ok(apiKey && apiSecret, 'Local integration credentials must be configured.');
  const api = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
  const owner: Principal = { userId: 'waiting-owner', displayName: 'Synthetic owner', deviceId: 'owner-device', isOwner: true, isAdmin: true };
  const audience: Principal = { userId: 'waiting-audience', displayName: 'Synthetic audience', deviceId: 'audience-device', isOwner: false, isAdmin: false };
  let service: StageService;
  const controller = createMediaController({ livekitUrl, apiKey, apiSecret,
    authorize: async (_request, identity, requestedRoom) => {
      const policy = service.mediaPolicy(identity);
      return policy?.roomName === requestedRoom ? policy : null;
    }, onConnection: (identity, connected) => service.setConnection(identity, connected),
  });
  service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId, media: controller });
  const gateway = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  controller.attach(gateway); gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const rooms: InstanceType<typeof rtc.Room>[] = [], sources: InstanceType<typeof rtc.AudioSource>[] = [], tracks: InstanceType<typeof rtc.LocalAudioTrack>[] = [];
  let roomName: string | undefined;
  t.after(async () => {
    for (const room of rooms) await room.disconnect().catch(() => {});
    for (const track of tracks) await track.close().catch(() => {});
    for (const source of sources) await source.close().catch(() => {});
    await controller.close(); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
    if (roomName) await api.deleteRoom(roomName).catch(() => {});
    service.close(); await rtc.dispose();
  });
  const connect = async (token: string) => {
    const room = new rtc.Room(); rooms.push(room);
    await room.connect(gatewayUrl, token, { autoSubscribe: true, dynacast: false });
    return room;
  };
  const publishMicrophone = async (room: InstanceType<typeof rtc.Room>) => {
    const source = new rtc.AudioSource(48000, 1); sources.push(source);
    const track = rtc.LocalAudioTrack.createAudioTrack('Synthetic waiting microphone', source); tracks.push(track);
    const publication = await room.localParticipant!.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
    await source.captureFrame(new rtc.AudioFrame(new Int16Array(480), 48000, 1, 480));
    return publication;
  };

  const opened = await service.execute(owner, { type: 'session.open', mode: 'stage' });
  roomName = opened.snapshot.session!.roomName;
  assert.equal(opened.snapshot.session!.state, 'waiting');
  const admission = await service.admit(audience);
  await controller.ensureRoom(roomName);
  await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
  await service.execute(audience, { type: 'mic.acquire' });
  const waitingToken = await controller.issueToken(service.mediaPolicy(admission.identity)!);
  const first = await connect(waitingToken); await publishMicrophone(first);
  await until(async () => (await api.getParticipant(roomName!, admission.identity)).tracks.some(track => track.source === TrackSource.MICROPHONE), 'Waiting audience microphone never appeared on the real SFU.');

  await service.execute(owner, { type: 'room.waiting-audio', enabled: false });
  const silent = await api.getParticipant(roomName, admission.identity);
  assert.equal(silent.tracks.some(track => track.source === TrackSource.MICROPHONE), false);
  assert.equal(silent.permission?.canPublishSources.includes(TrackSource.MICROPHONE), false);
  assert.equal(service.snapshot(audience).self.microphoneOwned, false);
  await first.disconnect();

  await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
  assert.equal(service.snapshot(audience).self.microphoneOwned, false, 'Re-enabling waits for a new member microphone choice.');
  await service.execute(audience, { type: 'mic.acquire' });
  const second = await connect(await controller.issueToken(service.mediaPolicy(admission.identity)!));
  await publishMicrophone(second);
  await until(async () => (await api.getParticipant(roomName!, admission.identity)).tracks.some(track => track.source === TrackSource.MICROPHONE), 'Re-enabled waiting microphone never appeared.');
  await service.execute(owner, { type: 'session.start' });
  const live = await api.getParticipant(roomName, admission.identity);
  assert.equal(service.snapshot(owner).session?.state, 'live');
  assert.equal(service.snapshot(owner).session?.mode, 'open');
  assert.equal(live.tracks.some(track => track.source === TrackSource.MICROPHONE), true);
  assert.equal(live.permission?.canPublishSources.includes(TrackSource.MICROPHONE), true);
  await service.execute(owner, { type: 'room.mode', mode: 'qa' });
  const restricted = await api.getParticipant(roomName, admission.identity);
  assert.equal(restricted.tracks.some(track => track.source === TrackSource.MICROPHONE), false);
  assert.equal(restricted.permission?.canPublishSources.includes(TrackSource.MICROPHONE), false);
  await second.disconnect();

  const replay = await connect(waitingToken);
  await assert.rejects(() => publishMicrophone(replay));
  assert.equal((await api.getParticipant(roomName, admission.identity)).tracks.some(track => track.source === TrackSource.MICROPHONE), false);
  t.diagnostic('Synthetic media only: Everyone retained the microphone on Go live; an explicit Q&A mode removed the actual track and grant, and the gateway denied the earlier Everyone token microphone publication.');
});

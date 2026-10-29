import 'dotenv/config';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import WebSocket from 'ws';
import { RoomServiceClient } from 'livekit-server-sdk';
import { SignalResponse, TrackSource } from '@livekit/protocol';
import { createMediaController } from '../backend/src/media/controller.js';
import type { MediaPolicy } from '../shared/types.js';

const enabled = process.env.RUN_LIVEKIT_INTEGRATION === '1';
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(100); }
  throw new Error(message);
}

test('real self-hosted SFU: screen audio decoding/cleanup, reconnect at three screens, source revocation, stale/refreshed tokens', { skip: enabled ? false : 'Set RUN_LIVEKIT_INTEGRATION=1 with the local LiveKit container running.', timeout: 120000 }, async t => {
  const rtc = await import('@livekit/rtc-node');
  const backendUrl = process.env.LIVEKIT_INTERNAL_URL ?? 'http://127.0.0.1:7880';
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;
  assert.ok(apiKey && apiSecret, 'Local LiveKit test credentials must be configured.');
  const roomName = `test-${randomUUID()}`;
  const policies = new Map<string, MediaPolicy>();
  const rooms: InstanceType<typeof rtc.Room>[] = [];
  const tracks: Array<InstanceType<typeof rtc.LocalVideoTrack> | InstanceType<typeof rtc.LocalAudioTrack>> = [];
  const sources: Array<InstanceType<typeof rtc.VideoSource> | InstanceType<typeof rtc.AudioSource>> = [];
  const frameTimers: ReturnType<typeof setInterval>[] = [];
  const readers: ReadableStreamDefaultReader[] = [];
  const api = new RoomServiceClient(backendUrl, apiKey, apiSecret);
  const controller = createMediaController({ livekitUrl: backendUrl, apiKey, apiSecret, authorize: async (_request, identity, requestedRoom) => requestedRoom === roomName ? policies.get(identity) ?? null : null, log: { warn(data, message) { t.diagnostic(`${message}: ${JSON.stringify(data)}`); } } });
  const gateway = createServer((request, response) => { response.statusCode = request.url?.startsWith('/rtc/v1') ? 404 : 200; response.end(); });
  const seenPaths = new Set<string>();
  gateway.on('upgrade', request => { const url = new URL(request.url ?? '/', 'http://localhost'); if (!seenPaths.has(url.pathname)) { seenPaths.add(url.pathname); t.diagnostic(`Native SDK signal path observed: ${url.pathname}.`); } });
  controller.attach(gateway);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  await controller.ensureRoom(roomName);
  t.after(async () => {
    frameTimers.forEach(clearInterval);
    for (const reader of readers) await reader.cancel().catch(() => {});
    for (const room of rooms) await room.disconnect().catch(() => {});
    for (const track of tracks) await track.close().catch(() => {});
    for (const source of sources) await source.close().catch(() => {});
    await controller.closeRoom(roomName).catch(() => {});
    await controller.close();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await rtc.dispose();
  });

  const makePolicy = (identity: string, microphone = false): MediaPolicy => {
    const policy: MediaPolicy = { identity, accountId: identity, userId: identity, deviceId: identity, admissionId: identity, roomName, sessionId: roomName, displayName: 'Synthetic test', active: true, allowedSources: microphone ? ['microphone', 'screen_share', 'screen_share_audio'] : ['screen_share', 'screen_share_audio'] };
    policies.set(identity, policy);
    return policy;
  };
  const connect = async (policy: MediaPolicy) => {
    const room = new rtc.Room();
    rooms.push(room);
    await room.connect(gatewayUrl, await controller.issueToken(policy), { autoSubscribe: true, dynacast: false });
    return room;
  };
  const publishScreen = async (room: InstanceType<typeof rtc.Room>) => {
    const source = new rtc.VideoSource(160, 90);
    sources.push(source);
    const track = rtc.LocalVideoTrack.createVideoTrack('Synthetic screen', source);
    tracks.push(track);
    const options = new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_SCREENSHARE, simulcast: false });
    const publication = await room.localParticipant!.publishTrack(track, options);
    const bytes = new Uint8Array(160 * 90 * 4);
    for (let i = 0; i < bytes.length; i += 4) { bytes[i] = 30; bytes[i + 1] = 120; bytes[i + 2] = 180; bytes[i + 3] = 255; }
    const frame = new rtc.VideoFrame(bytes, 160, 90, rtc.VideoBufferType.RGBA);
    frameTimers.push(setInterval(() => { try { source.captureFrame(frame); } catch {} }, 100));
    return publication;
  };
  const publishMicrophone = async (room: InstanceType<typeof rtc.Room>) => {
    const source = new rtc.AudioSource(48000, 1);
    sources.push(source);
    const track = rtc.LocalAudioTrack.createAudioTrack('Synthetic microphone', source);
    tracks.push(track);
    const publication = await room.localParticipant!.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
    await source.captureFrame(new rtc.AudioFrame(new Int16Array(480), 48000, 1, 480));
    return publication;
  };
  const publishScreenAudio = async (room: InstanceType<typeof rtc.Room>) => {
    const source = new rtc.AudioSource(48000, 1);
    sources.push(source);
    const track = rtc.LocalAudioTrack.createAudioTrack('Synthetic shared audio', source);
    tracks.push(track);
    const publication = await room.localParticipant!.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO }));
    const samples = Int16Array.from({ length: 960 }, (_, index) => Math.round(Math.sin(index * 2 * Math.PI * 440 / 48000) * 12000));
    const frame = new rtc.AudioFrame(samples, 48000, 1, 960);
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void source.captureFrame(frame).catch(() => {}).finally(() => { busy = false; });
    }, 20);
    frameTimers.push(timer);
    return { publication, stopFrames: () => clearInterval(timer) };
  };

  const listenerPolicy = { ...makePolicy('synthetic-listener'), allowedSources: [] };
  policies.set(listenerPolicy.identity, listenerPolicy);
  const listener = await connect(listenerPolicy);
  const decodedScreens = new Set<string>();
  const decodedSharedAudio = new Set<string>();
  const lastDecodedScreens = new Map<string, number>();
  const lastDecodedSharedAudio = new Map<string, number>();
  const unsubscribed = new Set<string>();
  listener.on(rtc.RoomEvent.TrackSubscribed, (track, publication) => {
    if (publication.source === rtc.TrackSource.SOURCE_SCREENSHARE) {
      const reader = new rtc.VideoStream(track).getReader();
      readers.push(reader);
      void (async () => {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          if (publication.sid) { decodedScreens.add(publication.sid); lastDecodedScreens.set(publication.sid, Date.now()); }
        }
      })().catch(() => {});
    } else if (publication.source === rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO) {
      const reader = new rtc.AudioStream(track, { sampleRate: 48000, numChannels: 1 }).getReader();
      readers.push(reader);
      void (async () => {
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            if (result.value.data.some(sample => Math.abs(sample) > 100)) {
              if (publication.sid) { decodedSharedAudio.add(publication.sid); lastDecodedSharedAudio.set(publication.sid, Date.now()); }
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      })().catch(() => {});
    }
  });
  listener.on(rtc.RoomEvent.TrackUnsubscribed, (_track, publication) => { if (publication.sid) unsubscribed.add(publication.sid); });

  const publisherPolicies = ['screen-one', 'screen-two', 'screen-three'].map((identity, index) => makePolicy(identity, index === 0));
  const publisherRooms = [];
  const screenPublications: Array<Awaited<ReturnType<typeof publishScreen>>> = [];
  for (const policy of publisherPolicies) { const room = await connect(policy); publisherRooms.push(room); screenPublications.push(await publishScreen(room)); }
  await until(() => decodedScreens.size === 3, 'A subscriber did not decode all three synthetic screen streams.', 20000);
  assert.equal((await api.listParticipants(roomName)).flatMap(participant => participant.tracks).filter(track => track.source === TrackSource.SCREEN_SHARE).length, 3);
  t.diagnostic('Three synthetic screen video streams were published through the gateway and decoded by a separate real WebRTC subscriber.');

  const sharedAudio = await publishScreenAudio(publisherRooms[1]);
  await until(() => decodedSharedAudio.has(sharedAudio.publication.sid!), 'A separate subscriber did not decode non-silent screen audio.', 20000);
  const audioPublisher = await api.getParticipant(roomName, publisherPolicies[1].identity);
  assert.deepEqual(audioPublisher.tracks.map(track => track.source).sort(), [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO].sort());
  assert.equal(audioPublisher.tracks.some(track => track.source === TrackSource.MICROPHONE), false);
  assert.equal(controller.guard.snapshot().filter(track => track.published && track.source === 'screen_share').length, 3);
  assert.equal(controller.guard.snapshot().filter(track => track.published && track.source === 'screen_share_audio').length, 1);
  t.diagnostic('One admission published screen video plus shared audio at the three-screen limit without microphone permission; a separate real WebRTC subscriber decoded non-silent audio.');

  const leasesBeforeResume = controller.guard.snapshot();
  let reconnecting = 0;
  let reconnected = 0;
  const screenCountsDuringResume: number[] = [];
  publisherRooms[1].on(rtc.RoomEvent.Reconnecting, () => {
    reconnecting++;
    screenCountsDuringResume.push(controller.guard.snapshot().filter(track => track.source === 'screen_share').length);
  });
  publisherRooms[1].on(rtc.RoomEvent.Reconnected, () => { reconnected++; });
  const resumeAt = Date.now();
  await publisherRooms[1].simulateScenario(rtc.SimulateScenarioKind.SIMULATE_SIGNAL_RECONNECT);
  await until(() => reconnecting === 1 && reconnected === 1, 'A signal-only interruption did not reconnect.', 30000);
  await until(() => (lastDecodedScreens.get(screenPublications[1].sid!) ?? 0) > resumeAt + 500
    && (lastDecodedSharedAudio.get(sharedAudio.publication.sid!) ?? 0) > resumeAt + 500,
  'The separate subscriber did not receive fresh screen video and non-silent shared audio after signal-only resume.', 20000);
  assert.deepEqual(screenCountsDuringResume, [3]);
  assert.deepEqual(controller.guard.snapshot(), leasesBeforeResume);
  assert.deepEqual((await api.getParticipant(roomName, publisherPolicies[1].identity)).tracks.map(track => track.sid).sort(),
    [screenPublications[1].sid!, sharedAudio.publication.sid!].sort());
  t.diagnostic('Signal-only interruption resumed the same screen/audio publications at three-screen capacity; all leases survived and fresh video plus non-silent audio reached the separate subscriber.');

  const fullReconnectAt = Date.now();
  await publisherRooms[1].simulateScenario(rtc.SimulateScenarioKind.SIMULATE_FULL_RECONNECT);
  await until(() => reconnecting === 2 && reconnected === 2, 'A full peer-connection rebuild did not reconnect.', 30000);
  await until(() => (lastDecodedScreens.get(screenPublications[1].sid!) ?? 0) > fullReconnectAt + 500
    && (lastDecodedSharedAudio.get(sharedAudio.publication.sid!) ?? 0) > fullReconnectAt + 500,
  'The separate subscriber did not decode screen video and non-silent shared audio after a full reconnect.', 20000);
  assert.deepEqual(screenCountsDuringResume, [3, 3]);
  assert.equal(controller.guard.snapshot().filter(track => track.source === 'screen_share').length, 3);
  assert.equal(controller.guard.snapshot().filter(track => track.source === 'screen_share_audio').length, 1);
  const rebuiltPublisher = await api.getParticipant(roomName, publisherPolicies[1].identity);
  assert.deepEqual(rebuiltPublisher.tracks.map(track => track.sid).sort(),
    [screenPublications[1].sid!, sharedAudio.publication.sid!].sort());
  assert.equal((await api.listParticipants(roomName)).flatMap(participant => participant.tracks).filter(track => track.source === TrackSource.SCREEN_SHARE).length, 3);
  t.diagnostic('Full peer-connection reconnect recovered screen video and non-silent shared audio at capacity with one publication per source and three total screens.');

  const fourthPolicy = makePolicy('screen-four');
  const fourthRoom = await connect(fourthPolicy);
  await assert.rejects(() => publishScreen(fourthRoom));
  assert.equal((await api.listParticipants(roomName)).flatMap(participant => participant.tracks).filter(track => track.source === TrackSource.SCREEN_SHARE).length, 3);
  await fourthRoom.disconnect();
  await controller.remove(roomName, fourthPolicy.identity);
  t.diagnostic('A fourth account with otherwise permitted screen grants was denied before a fourth screen track appeared on the SFU.');

  sharedAudio.stopFrames();
  await publisherRooms[1].localParticipant!.unpublishTrack(sharedAudio.publication.sid!);
  await publisherRooms[1].localParticipant!.unpublishTrack(screenPublications[1].sid!);
  await until(async () => (await api.getParticipant(roomName, publisherPolicies[1].identity)).tracks.length === 0
    && unsubscribed.has(sharedAudio.publication.sid!) && unsubscribed.has(screenPublications[1].sid!), 'Stopping a share did not remove both screen tracks from the SFU and receiving subscriber.');
  const replacementScreen = await publishScreen(publisherRooms[1]);
  const replacementAudio = await publishScreenAudio(publisherRooms[1]);
  await until(() => decodedScreens.has(replacementScreen.sid!) && decodedSharedAudio.has(replacementAudio.publication.sid!), 'The same admission could not restart screen video plus shared audio after stopping.');
  policies.set(publisherPolicies[1].identity, { ...publisherPolicies[1], allowedSources: [] });
  await controller.reconcile(roomName, [...policies.values()]);
  await until(async () => (await api.getParticipant(roomName, publisherPolicies[1].identity)).tracks.length === 0
    && unsubscribed.has(replacementScreen.sid!) && unsubscribed.has(replacementAudio.publication.sid!), 'Stage/share permission revocation did not remove associated screen audio and video from the SFU and subscriber.');
  replacementAudio.stopFrames();
  t.diagnostic('Explicit stop removed both tracks; the same admission restarted both successfully; revoking stage/share source permission then removed both from SFU and subscriber.');

  const primary = publisherRooms[0];
  const primaryPolicy = publisherPolicies[0];
  const originalToken = primary.token!;
  const primaryAudio = await publishScreenAudio(primary);
  await until(() => decodedSharedAudio.has(primaryAudio.publication.sid!), 'Primary screen audio did not decode before the microphone restriction.');
  await publishMicrophone(primary);
  await until(async () => (await api.getParticipant(roomName, primaryPolicy.identity)).tracks.some(track => track.source === TrackSource.MICROPHONE), 'Microphone track did not reach the SFU.');

  const otherDevicePolicy = { ...makePolicy('primary-other-device', true), accountId: primaryPolicy.accountId, userId: primaryPolicy.userId, allowedSources: ['microphone'] as const };
  policies.set(otherDevicePolicy.identity, { ...otherDevicePolicy, allowedSources: ['microphone'] });
  const otherDevice = await connect(policies.get(otherDevicePolicy.identity)!);
  await assert.rejects(() => publishMicrophone(otherDevice));
  await otherDevice.disconnect();
  await controller.remove(roomName, otherDevicePolicy.identity);
  policies.set(otherDevicePolicy.identity, { ...otherDevicePolicy, allowedSources: [] });
  const accountMicrophones = async () => (await api.listParticipants(roomName)).filter(participant => policies.get(participant.identity)?.accountId === primaryPolicy.accountId).flatMap(participant => participant.tracks).filter(track => track.source === TrackSource.MICROPHONE);
  assert.equal((await accountMicrophones()).length, 1);
  t.diagnostic('A second device of the same account was denied a concurrent microphone publication, even with source permission in the test fixture.');

  const beforeRefresh = primary.token;
  await api.updateParticipant(roomName, primaryPolicy.identity, { metadata: '{"testRefresh":true}' });
  await until(() => !!primary.token && primary.token !== beforeRefresh, 'The real SFU did not issue a refreshed token after participant update.');
  const refreshedSpeakerToken = primary.token!;

  policies.set(primaryPolicy.identity, { ...primaryPolicy, allowedSources: ['screen_share', 'screen_share_audio'] });
  await controller.reconcile(roomName, [...policies.values()]);
  const restricted = await api.getParticipant(roomName, primaryPolicy.identity);
  assert.equal(restricted.tracks.some(track => track.source === TrackSource.MICROPHONE), false);
  assert.equal(restricted.tracks.some(track => track.source === TrackSource.SCREEN_SHARE), true);
  assert.equal(restricted.tracks.some(track => track.source === TrackSource.SCREEN_SHARE_AUDIO), true);
  t.diagnostic('A microphone-only restriction removed the microphone publication while retaining the existing screen video and shared-audio publications.');

  policies.set(otherDevicePolicy.identity, { ...otherDevicePolicy, allowedSources: ['microphone'] });
  await controller.reconcile(roomName, [...policies.values()]);
  const handedOffDevice = await connect(policies.get(otherDevicePolicy.identity)!);
  await publishMicrophone(handedOffDevice);
  await until(async () => (await accountMicrophones()).length === 1, 'The handed-off microphone did not become visible on the SFU.');
  assert.equal((await accountMicrophones()).length, 1);
  assert.equal((await api.getParticipant(roomName, primaryPolicy.identity)).tracks.some(track => track.source === TrackSource.MICROPHONE), false);
  t.diagnostic('After confirmed source revocation, the microphone was handed to the second device with only one account microphone remaining on the SFU.');

  await primary.disconnect();
  const checkOldJoin = async (token: string) => {
    const socket = new WebSocket(`${gatewayUrl}/rtc?access_token=${token}&protocol=15&auto_subscribe=1`);
    const [data] = await once(socket, 'message');
    const join = SignalResponse.fromBinary(new Uint8Array(data as Buffer));
    assert.equal(join.message.case, 'join');
    if (join.message.case === 'join') assert.equal(join.message.value.participant?.permission?.canPublishSources.includes(TrackSource.MICROPHONE), false);
    socket.close();
    await once(socket, 'close');
    await controller.remove(roomName, primaryPolicy.identity);
  };
  await checkOldJoin(originalToken);
  await checkOldJoin(refreshedSpeakerToken);
  t.diagnostic('Both original and actual SFU-refreshed speaker tokens rejoined through current policy without microphone permission.');

  policies.set(primaryPolicy.identity, { ...primaryPolicy, active: false, allowedSources: [] });
  for (const token of [originalToken, refreshedSpeakerToken]) {
    const socket = new WebSocket(`${gatewayUrl}/rtc?access_token=${token}`);
    socket.on('error', () => {});
    const [, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, 403);
    response.resume();
    socket.terminate();
  }
  t.diagnostic('Both credential generations were rejected after admission invalidation (the same gate used for blocks, membership loss, and ended sessions).');

  // Deliberate trusted-host control: stock self-hosted signaling remains vulnerable to old JWT reuse.
  // This endpoint is loopback-only and must never be exposed as an alternative public ingress.
  const direct = new WebSocket(`${backendUrl.replace(/^http/u, 'ws')}/rtc?access_token=${refreshedSpeakerToken}&protocol=15&auto_subscribe=1`);
  const [directData] = await once(direct, 'message');
  const directJoin = SignalResponse.fromBinary(new Uint8Array(directData as Buffer));
  assert.equal(directJoin.message.case, 'join');
  if (directJoin.message.case === 'join') assert.equal(directJoin.message.value.participant?.permission?.canPublishSources.includes(TrackSource.MICROPHONE), true);
  direct.close();
  await once(direct, 'close');
  await controller.remove(roomName, primaryPolicy.identity);
  t.diagnostic('Control confirmed that the stock loopback SFU accepts an old speaker token; the application gateway and exclusive signaling boundary are necessary.');
});

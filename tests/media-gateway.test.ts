import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { AddTrackRequest, JoinResponse, ParticipantInfo, Room, SignalRequest, SignalResponse, TrackInfo, TrackSource, TrackType, TrickleRequest } from '@livekit/protocol';
import { RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import { createMediaController, type MediaControllerOptions } from '../backend/src/media/controller.js';
import { StageService } from '../backend/src/domain/stage-service.js';
import type { MediaPolicy, Principal } from '../shared/types.js';

const apiKey = 'local-test-api-key';
const apiSecret = 'local-test-secret-at-least-thirty-two-characters';
const newPolicy = (): MediaPolicy => ({ identity: 'opaque-admission', accountId: 'account', userId: 'account', deviceId: 'device', admissionId: 'admission', roomName: 'test-room', sessionId: 'test-session', displayName: 'Test member', active: true, allowedSources: ['microphone', 'screen_share', 'screen_share_audio'] });

async function fixture(options: Pick<MediaControllerOptions, 'onPublicationStopped' | 'roomService'> = {}) {
  let policy = newPolicy();
  const received: SignalRequest[] = [];
  const upstreamClaims: Array<Awaited<ReturnType<TokenVerifier['verify']>>> = [];
  const backend = createServer();
  const backendWs = new WebSocketServer({ server: backend });
  backendWs.on('connection', (socket, request) => {
    void new TokenVerifier(apiKey, apiSecret).verify(new URL(request.url!, 'http://localhost').searchParams.get('access_token')!).then(claims => upstreamClaims.push(claims));
    socket.send(new SignalResponse({ message: { case: 'join', value: new JoinResponse({ room: new Room({ name: policy.roomName }), participant: new ParticipantInfo({ identity: policy.identity }) }) } }).toBinary());
    socket.on('message', data => {
      const signal = SignalRequest.fromBinary(new Uint8Array(data as Buffer));
      received.push(signal);
      if (signal.message.case === 'addTrack') {
        const add = signal.message.value;
        socket.send(new SignalResponse({ message: { case: 'trackPublished', value: { cid: add.cid, track: new TrackInfo({ sid: `TR_${add.cid}`, source: add.source, type: add.type }) } } }).toBinary());
      }
    });
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = (backend.address() as AddressInfo).port;
  const media = createMediaController({ livekitUrl: `http://127.0.0.1:${backendPort}`, apiKey, apiSecret, ...options, authorize: async (request, identity, room) => request.headers.cookie === 'session=valid; device=bound' && policy.identity === identity && policy.roomName === room ? policy : null });
  const gateway = createServer((request, response) => { response.statusCode = request.url?.startsWith('/rtc/v1') ? 404 : 200; response.end(); });
  media.attach(gateway);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayPort = (gateway.address() as AddressInfo).port;
  const connect = (token: string, cookie = 'session=valid; device=bound', path = '/rtc') => new WebSocket(`ws://127.0.0.1:${gatewayPort}${path}?access_token=${token}`, { headers: { cookie } });
  const cleanup = async () => {
    await media.close();
    for (const socket of backendWs.clients) socket.terminate();
    await new Promise<void>(resolve => backendWs.close(() => resolve()));
    await Promise.all([new Promise<void>(resolve => backend.close(() => resolve())), new Promise<void>(resolve => gateway.close(() => resolve()))]);
  };
  const sendResponse = (response: SignalResponse) => {
    assert.equal(backendWs.clients.size, 1, 'The isolated response probe expects one connected browser fixture.');
    for (const socket of backendWs.clients) socket.send(response.toBinary());
  };
  return { media, connect, received, upstreamClaims, cleanup, sendResponse, setPolicy: (next: MediaPolicy) => { policy = next; }, getPolicy: () => policy };
}

async function expectRejected(socket: WebSocket, expectedStatus = 403) {
  socket.on('error', () => {});
  const [, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, expectedStatus);
  response.resume();
  socket.terminate();
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 1500;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), message);
}

test('gateway reissues an old speaker credential using current subscribe-only policy', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const oldToken = await f.media.issueToken(f.getPolicy());
  f.setPolicy({ ...f.getPolicy(), allowedSources: [] });
  const socket = f.connect(oldToken);
  await once(socket, 'message');
  assert.equal(f.upstreamClaims.length, 1);
  assert.equal(f.upstreamClaims[0].video?.canPublish, false);
  assert.equal(f.upstreamClaims[0].video?.canPublishData, false);
  socket.close();
});

test('old and replacement credentials are denied after admission revocation; device binding is required', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const original = await f.media.issueToken(f.getPolicy());
  const refreshedEquivalent = await f.media.issueToken(f.getPolicy());
  await expectRejected(f.connect(original, 'session=valid; device=wrong'));
  f.setPolicy({ ...f.getPolicy(), active: false });
  await expectRejected(f.connect(original));
  await expectRejected(f.connect(refreshedEquivalent));
});

test('extra screen AddTrack is refused before upstream receives it', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const socket = f.connect(await f.media.issueToken(f.getPolicy()));
  await once(socket, 'message');
  socket.send(new SignalRequest({ message: { case: 'addTrack', value: new AddTrackRequest({ cid: 'first', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO }) } }).toBinary());
  await once(socket, 'message');
  const closed = once(socket, 'close');
  socket.send(new SignalRequest({ message: { case: 'addTrack', value: new AddTrackRequest({ cid: 'second', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO }) } }).toBinary());
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(f.received.filter(request => request.message.case === 'addTrack').length, 1);
});

test('opaque v1 join requests cannot bypass classic publication inspection', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  await expectRejected(f.connect(await f.media.issueToken(f.getPolicy()), undefined, '/rtc/v1'), 404);
});

test('an authenticated signaling flood is disconnected with bounded upstream work', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const socket = f.connect(await f.media.issueToken(f.getPolicy()));
  await once(socket, 'message');
  const closed = once(socket, 'close');
  const ping = new SignalRequest({ message: { case: 'ping', value: 1n } }).toBinary();
  for (let index = 0; index < 500; index++) socket.send(ping);
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.ok(f.received.length <= 120, 'The gateway must not forward an unbounded burst.');
});

test('a valid-size ICE burst has a separate bounded budget from control commands', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const socket = f.connect(await f.media.issueToken(f.getPolicy()));
  await once(socket, 'message');
  const trickle = new SignalRequest({ message: { case: 'trickle', value: new TrickleRequest({ candidateInit: '{}' }) } }).toBinary();
  for (let index = 0; index < 200; index++) socket.send(trickle);
  const deadline = Date.now() + 2000;
  while (f.received.length < 200 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.received.length, 200);
  assert.equal(socket.readyState, WebSocket.OPEN);
  socket.close();
});

test('stale participant snapshots cannot release an active screen/audio reservation or erase its publication leases', async t => {
  const actor: Principal = { userId: 'synthetic-owner', displayName: 'Synthetic owner', deviceId: 'test-device', isOwner: true, isAdmin: true };
  const service = new StageService({ databasePath: ':memory:', ownerUserId: actor.userId });
  t.after(() => service.close());
  await service.execute(actor, { type: 'session.open', mode: 'stage', title: 'Isolated stale media update' });
  const admission = await service.admit(actor);
  await service.execute(actor, { type: 'member.stage', userId: actor.userId, onStage: true });
  await service.execute(actor, { type: 'share.reserve' });
  const stops: string[] = [];
  let apiSnapshot = new ParticipantInfo({ sid: 'PA_owner', identity: admission.identity, version: 12 });
  const roomService = new RoomServiceClient('http://127.0.0.1', apiKey, apiSecret);
  roomService.getParticipant = async () => apiSnapshot;
  const f = await fixture({ roomService, onPublicationStopped: async (identity, source, reservationId) => {
    stops.push(source);
    if (source === 'screen_share') {
      await service.releaseShareByIdentity(identity, reservationId);
      f.setPolicy(service.mediaPolicy(identity)!);
    }
  } });
  t.after(f.cleanup);
  f.setPolicy(service.mediaPolicy(admission.identity)!);
  const socket = f.connect(await f.media.issueToken(f.getPolicy()));
  await once(socket, 'message');
  const screen = new TrackInfo({ sid: 'TR_screen', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO });
  const audio = new TrackInfo({ sid: 'TR_audio', source: TrackSource.SCREEN_SHARE_AUDIO, type: TrackType.AUDIO });
  const update = async (version: number, tracks: TrackInfo[]) => {
    const delivered = once(socket, 'message');
    f.sendResponse(new SignalResponse({ message: { case: 'update', value: { participants: [new ParticipantInfo({ sid: 'PA_owner', identity: admission.identity, version, tracks })] } } }));
    await delivered;
  };
  const publish = async (cid: string, source: TrackSource, type: TrackType) => {
    const published = once(socket, 'message');
    socket.send(new SignalRequest({ message: { case: 'addTrack', value: new AddTrackRequest({ cid, source, type }) } }).toBinary());
    await published;
  };
  await update(10, []);
  await publish('screen', TrackSource.SCREEN_SHARE, TrackType.VIDEO);
  await update(11, [screen]);
  await publish('audio', TrackSource.SCREEN_SHARE_AUDIO, TrackType.AUDIO);
  await update(12, [screen, audio]);
  // The official browser SDK discards lower ParticipantInfo versions for the
  // same SID. These delayed snapshots must not become stronger authority here.
  await update(11, [screen]);
  await update(10, []);
  assert.equal(service.snapshot(actor).shares.length, 1, 'A stale empty participant snapshot falsely released the live screen/audio reservation.');
  assert.equal(f.media.guard.snapshot().length, 2, 'A stale video-only snapshot falsely erased the active shared-audio publication lease.');
  assert.equal(stops.length, 0);
  // A current complete absence still ends the reservation through the same
  // trusted callback; ignoring stale snapshots must not disable real cleanup.
  apiSnapshot = new ParticipantInfo({ sid: 'PA_owner', identity: admission.identity, version: 13 });
  await update(13, []);
  await waitFor(() => service.snapshot(actor).shares.length === 0, 'A current SFU-confirmed absence must still release the reservation.');
  assert.equal(f.media.guard.snapshot().length, 0);
  socket.close();
});

test('a latest pre-publication snapshot cannot erase newly acknowledged screen/audio tracks and metadata checks do not block signaling', async t => {
  const roomService = new RoomServiceClient('http://127.0.0.1', apiKey, apiSecret);
  let resolveMetadata!: (participant: ParticipantInfo) => void;
  let metadataCalls = 0;
  const metadata = new Promise<ParticipantInfo>(resolve => { resolveMetadata = resolve; });
  roomService.getParticipant = async () => { metadataCalls++; return metadata; };
  const stops: string[] = [];
  const f = await fixture({ roomService, onPublicationStopped: async (_identity, source) => { stops.push(source); } });
  t.after(f.cleanup);
  const socket = f.connect(await f.media.issueToken(f.getPolicy()));
  await once(socket, 'message');
  const deliver = async (response: SignalResponse) => { const received = once(socket, 'message'); f.sendResponse(response); await received; };
  const update = (version: number, tracks: TrackInfo[]) => deliver(new SignalResponse({ message: { case: 'update', value: { participants: [new ParticipantInfo({ sid: 'PA_test', identity: f.getPolicy().identity, version, tracks })] } } }));
  const publish = async (cid: string, source: TrackSource, type: TrackType) => {
    const response = once(socket, 'message');
    socket.send(new SignalRequest({ message: { case: 'addTrack', value: new AddTrackRequest({ cid, source, type }) } }).toBinary());
    await response;
  };
  await deliver(new SignalResponse({ message: { case: 'join', value: new JoinResponse({ participant: new ParticipantInfo({ sid: 'PA_test', identity: f.getPolicy().identity, version: 10 }) }) } }));
  await publish('screen', TrackSource.SCREEN_SHARE, TrackType.VIDEO);
  await update(9, []);
  assert.equal(metadataCalls, 0, 'The join response must seed the monotonic self version before any updates arrive.');
  await update(10, []); // latest known version, created before trackPublished
  await publish('audio', TrackSource.SCREEN_SHARE_AUDIO, TrackType.AUDIO);
  assert.equal(metadataCalls, 1);
  assert.equal(f.media.guard.snapshot().length, 2, 'A pending metadata request must not erase a new publication or hold up the second track acknowledgement.');
  const screen = new TrackInfo({ sid: 'TR_screen', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO });
  const audio = new TrackInfo({ sid: 'TR_audio', source: TrackSource.SCREEN_SHARE_AUDIO, type: TrackType.AUDIO });
  resolveMetadata(new ParticipantInfo({ sid: 'PA_test', identity: f.getPolicy().identity, version: 11, tracks: [screen, audio] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops.length, 0);
  assert.equal(f.media.guard.snapshot().length, 2);
  // Explicit server unpublish is sufficient authority and does not wait for a
  // participant snapshot or another control API read.
  await deliver(new SignalResponse({ message: { case: 'trackUnpublished', value: { trackSid: 'TR_screen' } } }));
  await waitFor(() => stops.includes('screen_share'), 'Explicit unpublish must immediately notify the domain.');
  assert.equal(f.media.guard.snapshot().length, 1);
  assert.equal(metadataCalls, 1);
  socket.close();
});

test('late absence verification cannot remove a replacement reservation even if a track SID is reused', async t => {
  const roomService = new RoomServiceClient('http://127.0.0.1', apiKey, apiSecret);
  let resolveMetadata!: (participant: ParticipantInfo) => void;
  roomService.getParticipant = async () => new Promise<ParticipantInfo>(resolve => { resolveMetadata = resolve; });
  const stops: Array<{ source: string; reservationId?: string }> = [];
  const f = await fixture({ roomService, onPublicationStopped: async (_identity, source, reservationId) => { stops.push({ source, reservationId }); } });
  t.after(f.cleanup);
  f.setPolicy({ ...f.getPolicy(), shareReservationId: 'old-reservation' });
  const socket = f.connect(await f.media.issueToken(f.getPolicy()));
  await once(socket, 'message');
  const publish = async () => {
    const response = once(socket, 'message');
    socket.send(new SignalRequest({ message: { case: 'addTrack', value: new AddTrackRequest({ cid: 'screen', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO }) } }).toBinary());
    await response;
  };
  const deliver = async (response: SignalResponse) => { const received = once(socket, 'message'); f.sendResponse(response); await received; };
  await publish();
  await deliver(new SignalResponse({ message: { case: 'update', value: { participants: [new ParticipantInfo({ sid: 'PA_test', identity: f.getPolicy().identity, version: 10 })] } } }));
  await deliver(new SignalResponse({ message: { case: 'trackUnpublished', value: { trackSid: 'TR_screen' } } }));
  f.setPolicy({ ...f.getPolicy(), shareReservationId: 'new-reservation' });
  await publish();
  resolveMetadata(new ParticipantInfo({ sid: 'PA_test', identity: f.getPolicy().identity, version: 11 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.media.guard.snapshot().length, 1);
  assert.equal(f.media.guard.snapshot()[0].reservationId, 'new-reservation');
  assert.deepEqual(stops, [{ source: 'screen_share', reservationId: 'old-reservation' }]);
  socket.close();
});

test('failed or timed-out current metadata retains publication leases and an outstanding request is deduplicated', async t => {
  for (const failure of ['error', 'timeout'] as const) {
    const roomService = new RoomServiceClient('http://127.0.0.1', apiKey, apiSecret);
    let calls = 0;
    roomService.getParticipant = async () => { calls++; if (failure === 'error') throw new Error('Isolated control API failure.'); return new Promise<ParticipantInfo>(() => {}); };
    const stopped: string[] = [];
    const f = await fixture({ roomService, onPublicationStopped: async (_identity, source) => { stopped.push(source); } });
    const socket = f.connect(await f.media.issueToken(f.getPolicy()));
    try {
      await once(socket, 'message');
      const published = once(socket, 'message');
      socket.send(new SignalRequest({ message: { case: 'addTrack', value: new AddTrackRequest({ cid: 'screen', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO }) } }).toBinary());
      await published;
      for (let version = 10; version < (failure === 'timeout' ? 14 : 11); version++) {
        const response = once(socket, 'message');
        f.sendResponse(new SignalResponse({ message: { case: 'update', value: { participants: [new ParticipantInfo({ sid: 'PA_test', identity: f.getPolicy().identity, version })] } } }));
        await response;
      }
      if (failure === 'timeout') await new Promise(resolve => setTimeout(resolve, 1050));
      assert.equal(calls, 1, 'Only one actual metadata call may remain outstanding, including after its observation timeout.');
      assert.equal(f.media.guard.snapshot().length, 1, 'An unverifiable absence must retain its quota lease.');
      assert.deepEqual(stopped, []);
    } finally { socket.close(); await f.cleanup(); }
  }
});

for (const path of ['signal-update', 'reconcile'] as const) {
  test(`an acknowledged but unobserved screen retains its lease through empty ${path} metadata until real presence then absence`, async t => {
    const roomService = new RoomServiceClient('http://127.0.0.1', apiKey, apiSecret);
    const identity = newPolicy().identity;
    const participant = (version: number, tracks: TrackInfo[], sid = 'PA_pending') => new ParticipantInfo({
      sid, identity, version, tracks,
      permission: { canPublish: true, canSubscribe: true, canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] },
    });
    let snapshot = participant(10, []), metadataCalls = 0;
    roomService.getParticipant = async () => { metadataCalls++; return snapshot; };
    roomService.listParticipants = async () => [snapshot];
    roomService.updateParticipant = async () => snapshot;
    const stops: string[] = [];
    const f = await fixture({ roomService, onPublicationStopped: async (_identity, source) => { stops.push(source); } });
    t.after(f.cleanup);
    f.setPolicy({ ...f.getPolicy(), shareReservationId: 'pending-reservation' });
    const socket = f.connect(await f.media.issueToken(f.getPolicy()));
    await once(socket, 'message');
    const deliver = async (response: SignalResponse) => { const received = once(socket, 'message'); f.sendResponse(response); await received; };
    const update = async () => {
      if (path === 'reconcile') await f.media.reconcile(f.getPolicy().roomName, [f.getPolicy()]);
      else {
        await deliver(new SignalResponse({ message: { case: 'update', value: { participants: [snapshot] } } }));
        await waitFor(() => metadataCalls > 0, 'The isolated metadata verification did not run.');
        await new Promise(resolve => setImmediate(resolve));
      }
    };
    await deliver(new SignalResponse({ message: { case: 'join', value: new JoinResponse({ participant: snapshot }) } }));
    const published = once(socket, 'message');
    socket.send(new SignalRequest({ message: { case: 'addTrack', value: new AddTrackRequest({ cid: 'pending-screen', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO }) } }).toBinary());
    await published;
    await update();
    assert.equal(f.media.guard.snapshot().length, 1, 'Empty metadata before first SFU presence must not erase the acknowledged publication or release its reservation.');
    assert.deepEqual(stops, [], 'An AddTrack acknowledgement followed by an empty pre-negotiation snapshot is not a real stopped track.');

    const screen = new TrackInfo({ sid: 'TR_pending-screen', source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO });
    snapshot = participant(11, [screen]);
    if (path === 'reconcile') await update();
    else await deliver(new SignalResponse({ message: { case: 'update', value: { participants: [snapshot] } } }));
    assert.equal(f.media.guard.snapshot().length, 1);
    for (const version of [10, 11]) {
      snapshot = participant(version, []);
      await update();
      assert.equal(f.media.guard.snapshot().length, 1, 'Older/equal pre-appearance metadata cannot prove absence after positive SFU presence.');
      assert.deepEqual(stops, []);
    }
    snapshot = participant(100, [], 'PA_previous');
    await update();
    assert.equal(f.media.guard.snapshot().length, 1, 'A different participant generation cannot prove this publication stopped.');
    snapshot = participant(12, []);
    await update();
    await waitFor(() => f.media.guard.snapshot().length === 0, 'A true absence after positive SFU presence must still clean the publication lease.');
    if (path === 'signal-update') assert.deepEqual(stops, ['screen_share']);
    socket.close();
  });
}

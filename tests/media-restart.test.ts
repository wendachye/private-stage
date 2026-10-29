import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import WebSocket from 'ws';
import type { Command, CommandResult, RoomSnapshot } from '../shared/types.ts';

const enabled = process.env.RUN_LIVEKIT_INTEGRATION === '1';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, reason: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(100); }
  throw new Error(reason);
}

test('real SFU survives fixture app crash; restart stays closed until surviving room cleanup succeeds', {
  skip: enabled ? false : 'Set RUN_LIVEKIT_INTEGRATION=1 with the local LiveKit container running.', timeout: 90000,
}, async t => {
  const rtc = await import('@livekit/rtc-node');
  const livekitUrl = process.env.LIVEKIT_INTERNAL_URL ?? 'http://127.0.0.1:7880';
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;
  assert.ok(apiKey && apiSecret, 'Local LiveKit test credentials must be configured.');
  const api = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
  const directory = mkdtempSync(join(tmpdir(), 'stage-crash-test-'));
  const origin = 'http://localhost:3210';
  const cookies = new Map<string, string>();
  const children: ChildProcess[] = [];
  let roomName: string | undefined;
  let failCleanup = false, cleanupFailures = 0;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader | undefined;
  let source: InstanceType<typeof rtc.VideoSource> | undefined;
  let track: InstanceType<typeof rtc.LocalVideoTrack> | undefined;
  const publisher = new rtc.Room(), subscriber = new rtc.Room();
  // Only the isolated fixture's server-side DeleteRoom calls are faulted. The
  // production app and container, other rooms, and direct RTP paths are untouched.
  const faultProxy = createServer((request, response) => {
    if (failCleanup && request.url?.endsWith('/DeleteRoom')) {
      cleanupFailures++;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'unavailable', msg: 'Isolated restart-test fault.' }));
      return;
    }
    const upstream = proxyRequest(new URL(request.url ?? '/', livekitUrl), {
      method: request.method, headers: { ...request.headers, host: new URL(livekitUrl).host },
    }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  faultProxy.listen(0, '127.0.0.1');
  await once(faultProxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${(faultProxy.address() as AddressInfo).port}`;
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env, DATA_DIR: directory, HOST: '127.0.0.1', APP_URL: origin,
    NODE_ENV: 'test', LOCAL_PREVIEW: 'true', SESSION_KEY: randomBytes(32).toString('hex'),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'), LIVEKIT_INTERNAL_URL: proxyUrl,
    DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_GUILD_ID: '', DISCORD_OWNER_ID: '',
  };
  const entry = `import{createApp}from${JSON.stringify(new URL('../backend/src/app.ts', import.meta.url).href)};import{loadConfig}from${JSON.stringify(new URL('../backend/src/config.ts', import.meta.url).href)};const{app}=await createApp(loadConfig(),{disableFrontend:true,quiet:true});await app.listen({host:'127.0.0.1',port:0});process.send({port:app.server.address().port});process.on('message',async message=>{if(message==='stop'){await app.close();process.exit(0);}});`;
  const start = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', entry], {
      env: fixtureEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    // Keep diagnostics private: fixture errors cannot accidentally print keys or JWTs.
    child.stderr?.resume();
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message as { port: number }),
      once(child, 'exit').then(([code]) => { throw new Error(`Isolated app stopped before readiness (${code}).`); }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Isolated app startup timed out.')), 15000).unref()),
    ]);
    assert.ok(ready.port > 0);
    return { child, url: `http://127.0.0.1:${ready.port}` };
  };
  let baseUrl = '';
  const call = async <T>(path: string, payload?: unknown, expectedStatus = 200): Promise<T> => {
    const response = await fetch(baseUrl + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { origin, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    for (const header of response.headers.getSetCookie()) { const [pair] = header.split(';'); const equals = pair!.indexOf('='); cookies.set(pair!.slice(0, equals), pair!.slice(equals + 1)); }
    assert.equal(response.status, expectedStatus, `Unexpected status for ${path}.`);
    return await response.json() as T;
  };
  const command = (payload: Command, expectedStatus = 200) => call<CommandResult>('/api/commands', payload, expectedStatus);
  const state = () => call<RoomSnapshot>('/api/state');

  t.after(async () => {
    if (frameTimer) clearInterval(frameTimer);
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      if (child.connected) child.send('stop');
      await Promise.race([exited, wait(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    await reader?.cancel().catch(() => {});
    await publisher.disconnect().catch(() => {}); await subscriber.disconnect().catch(() => {});
    await track?.close().catch(() => {}); await source?.close().catch(() => {});
    if (roomName) await api.deleteRoom(roomName).catch(() => {});
    faultProxy.closeAllConnections();
    await new Promise<void>(resolve => faultProxy.close(() => resolve()));
    await rtc.dispose();
    assert.ok(directory.startsWith(join(tmpdir(), 'stage-crash-test-')));
    rmSync(directory, { recursive: true, force: true });
  });

  const first = await start(); baseUrl = first.url;
  await call('/api/bootstrap'); await call('/api/dev/login', { persona: 'owner' });
  const schedule = await command({ type: 'schedule.save', title: 'Isolated restart reservation', startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 90000000).toISOString() });
  const scheduleId = schedule.snapshot.schedules[0]!.id;
  const opened = await command({ type: 'session.open', mode: 'stage', scheduleId });
  await command({ type: 'session.start' });
  const priorSessionId = opened.snapshot.session!.id;
  roomName = opened.snapshot.session!.roomName;
  const joined = await command({ type: 'room.join' });
  const identity = joined.snapshot.self.admission!.identity;
  await command({ type: 'member.stage', userId: 'preview-owner', onStage: true });
  await command({ type: 'share.reserve' });
  const sent = await command({ type: 'chat.send', text: 'Synthetic restart-only message.' });
  await command({ type: 'chat.pin', messageId: sent.snapshot.messages[0]!.id, pinned: true });
  const { token } = await call<{ token: string }>('/api/media/token', {});

  // Deliberate trusted-host control, not the public gateway: the native SDK lacks
  // browser cookie/Origin options. This preserves real RTP independently of the
  // crashed process so startup must actually remove the surviving SFU room.
  const listenerToken = new AccessToken(apiKey, apiSecret, { identity: `crash-observer-${randomUUID()}` });
  listenerToken.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true });
  let decodedFrames = 0;
  subscriber.on(rtc.RoomEvent.TrackSubscribed, (remote, publication) => {
    if (publication.source !== rtc.TrackSource.SOURCE_SCREENSHARE) return;
    reader = new rtc.VideoStream(remote).getReader();
    const activeReader = reader;
    void (async () => { try { while (!(await activeReader.read()).done) decodedFrames++; } catch {} })();
  });
  await subscriber.connect(livekitUrl.replace(/^http/, 'ws'), await listenerToken.toJwt(), { autoSubscribe: true, dynacast: false });
  await publisher.connect(livekitUrl.replace(/^http/, 'ws'), token, { autoSubscribe: true, dynacast: false });
  source = new rtc.VideoSource(160, 90);
  track = rtc.LocalVideoTrack.createVideoTrack('Synthetic restart screen', source);
  await publisher.localParticipant!.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_SCREENSHARE, simulcast: false }));
  const pixels = new Uint8Array(160 * 90 * 4).fill(128);
  const frame = new rtc.VideoFrame(pixels, 160, 90, rtc.VideoBufferType.RGBA);
  frameTimer = setInterval(() => { try { source!.captureFrame(frame); } catch {} }, 100);
  await until(() => decodedFrames >= 3, 'Subscriber did not decode the synthetic restart stream.');
  assert.ok((await api.getParticipant(roomName, identity)).tracks.some(item => item.source === TrackSource.SCREEN_SHARE));

  const stopped = once(first.child, 'exit'); first.child.kill('SIGKILL'); await stopped;
  const framesAtCrash = decodedFrames;
  await until(() => decodedFrames >= framesAtCrash + 3, 'Synthetic RTP did not survive the isolated app crash.');
  t.diagnostic('Killed only the isolated app process. Its loopback-control SFU stream continued decoding after the crash.');

  failCleanup = true;
  const second = await start(); baseUrl = second.url;
  const blocked = await state();
  assert.equal(blocked.session, null); assert.equal(blocked.cleanupPending, true);
  assert.equal(blocked.mediaSyncPending, true); assert.equal(blocked.self.admission, null);
  assert.deepEqual(blocked.messages, []); assert.deepEqual(blocked.pins, []); assert.deepEqual(blocked.shares, []);
  assert.equal(blocked.schedules.find(item => item.id === scheduleId)?.status, 'completed');
  assert.ok(blocked.audit?.some(item => item.action === 'session.restart-close' && item.sessionId === priorSessionId));
  assert.equal((await call<{ error: string }>('/api/commands', { type: 'session.open', mode: 'stage', title: 'Must stay closed' }, 503)).error, 'cleanup_pending');
  await call('/api/media/token', {}, 403);
  assert.ok(cleanupFailures > 0);
  assert.ok((await api.getParticipant(roomName, identity)).tracks.some(item => item.source === TrackSource.SCREEN_SHARE));
  t.diagnostic('Real DeleteRoom API failure kept cleanup pending, admissions unavailable, and explicit reopening denied.');

  failCleanup = false;
  await until(async () => !(await state()).cleanupPending, 'Maintenance did not finish real SFU cleanup after recovery.');
  await until(async () => (await api.listRooms([roomName!])).length === 0, 'Prior SFU room survived confirmed cleanup.');
  await until(() => !publisher.isConnected && !subscriber.isConnected, 'Old WebRTC participants were not disconnected by room deletion.');
  const recovered = await state();
  assert.equal(recovered.session, null); assert.equal(recovered.mediaSyncPending, false);
  await call('/api/media/token', {}, 403);
  const rejectOldCredential = async () => {
    const stale = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/rtc?access_token=${token}`, {
      headers: { origin, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
    });
    stale.on('error', () => {});
    try {
      const [, denied] = await Promise.race([
        once(stale, 'unexpected-response'),
        once(stale, 'open').then(() => { throw new Error('Old media credential unexpectedly connected.'); }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Old-credential denial timed out.')), 5000).unref()),
      ]);
      assert.equal(denied.statusCode, 403); denied.resume();
    } finally { stale.terminate(); }
  };
  await rejectOldCredential();
  const reopened = await command({ type: 'session.open', mode: 'stage', title: 'Fresh explicit restart session' });
  assert.notEqual(reopened.snapshot.session!.id, priorSessionId);
  assert.notEqual(reopened.snapshot.session!.roomName, roomName);
  assert.equal(reopened.snapshot.session!.state, 'waiting');
  assert.ok(reopened.snapshot.self.admission, 'Explicit reopening admits the current host into the new waiting room.');
  assert.notEqual(reopened.snapshot.self.admission.id, joined.snapshot.self.admission!.id);
  assert.notEqual(reopened.snapshot.self.admission.identity, identity);
  assert.equal(reopened.snapshot.self.admission.sessionId, reopened.snapshot.session!.id);
  assert.equal(reopened.snapshot.self.microphoneOwned, false);
  const freshMedia = await call<{ token: string }>('/api/media/token', {});
  assert.ok(freshMedia.token);
  assert.notEqual(freshMedia.token, token, 'Reopening must issue a fresh-session credential, never revive the old one.');
  await rejectOldCredential();
  await command({ type: 'session.end' });
  t.diagnostic('Maintenance deleted the prior SFU room and disconnected both real peers. Old JWT/admission failed; only explicit reopening created new session/media identities.');
});

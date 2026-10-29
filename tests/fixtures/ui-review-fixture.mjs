// Isolated, loopback-only UI fixture. Uses the real API/domain and the running
// app's frontend assets, with fictional preview identities and no OAuth.
// Run only when requested: node --import tsx tests/fixtures/ui-review-fixture.mjs
// UI_REVIEW_START_CLOSED=1 skips fictional room seeding. UI_REVIEW_REAL_MEDIA=1
// enables the loopback SFU for this isolated database's own random room only.
// Edit work/ui-review-fixture/faults.json to set any of:
// { commandVerificationUnavailable: true, verificationRetryAfterSeconds: 5,
//   chatResponseDelayMs: 2500, dropFirstChatResponse: true,
//   scheduleSaveResponseDelayMs: 3500 }
// Fault flags never come from HTTP. No cookies, keys, bodies, or real data log.
import { createServer, request as forward } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { RoomServiceClient } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { createApp } from '../../backend/src/app.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(projectRoot, 'work', 'ui-review-fixture');
const host = '127.0.0.1';

const noMedia = async () => {};
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const listen = server => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, host, () => { server.off('error', reject); resolveListen(server.address().port); });
});

function previewConfig(origin, dataDir, mediaSettings) {
  return {
    APP_NAME: 'Private Stage', HOST: host, PORT: Number(new URL(origin).port), APP_URL: origin,
    NODE_ENV: 'test', LOCAL_PREVIEW: 'true', SESSION_KEY: '1'.repeat(64), TOKEN_ENCRYPTION_KEY: '2'.repeat(64), DATA_DIR: dataDir,
    DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_GUILD_ID: '', DISCORD_OWNER_ID: '', DISCORD_ADMIN_ROLE_IDS: '',
    LIVEKIT_INTERNAL_URL: mediaSettings?.url ?? 'http://127.0.0.1:9', LIVEKIT_API_KEY: mediaSettings?.apiKey ?? '', LIVEKIT_API_SECRET: mediaSettings?.apiSecret ?? '',
    MEMBERSHIP_CACHE_SECONDS: 60, MEMBERSHIP_RECHECK_SECONDS: 60, MEMBERSHIP_MAX_STALE_SECONDS: 300,
    preview: true, discordConfigured: false, missing: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'DISCORD_OWNER_ID'],
    dataDir, cookieSecure: false, origin, ownerUserId: 'preview-owner', adminRoleIds: [], mediaConfigured: !!mediaSettings,
  };
}

async function seed(service) {
  const principal = (userId, displayName, admin = false, owner = false) => ({ userId, displayName, deviceId: `fixture-${userId}`, isAdmin: admin, isOwner: owner });
  const owner = principal('preview-owner', 'Alex · Owner', true, true);
  const admin = principal('preview-admin', 'Sam · Admin', true);
  const member = principal('preview-member', 'Jordan · Member');
  const longName = principal('preview-member2', 'Riley Morgan — Community Research and Education');
  const third = principal('preview-member3', 'Casey · Member');
  const restricted = principal('fixture-restricted', 'Taylor · Restorable test member');
  await service.execute(owner, { type: 'session.open', mode: 'stage', title: 'Community research room' });
  await service.execute(owner, { type: 'session.start' });
  for (const actor of [owner, admin, member, longName, third, restricted]) {
    const admission = await service.admit(actor);
    await service.setConnection(admission.identity, true);
  }
  for (const actor of [owner, admin]) await service.execute(owner, { type: 'member.stage', userId: actor.userId, onStage: true });
  await service.execute(member, { type: 'hand.set', raised: true });
  const message = await service.execute(owner, { type: 'chat.send', text: 'Welcome. These are fictional people and messages for checking the room controls.', clientId: 'fixture-welcome' });
  const welcome = message.snapshot.messages.find(item => item.clientId === 'fixture-welcome');
  if (welcome) await service.execute(owner, { type: 'chat.pin', messageId: welcome.id, pinned: true });
  await service.execute(member, { type: 'chat.send', text: 'Can we review the chart layout and the reading order on a smaller screen?', clientId: 'fixture-question' });
  await service.execute(longName, { type: 'chat.send', text: 'A longer message for the responsive check: key levels, the session plan, and questions should remain readable without hiding the message actions or the composer.', clientId: 'fixture-long-message' });
  await service.execute(admin, { type: 'chat.send', text: 'The room starts muted. Raise your hand when you would like to join the stage.', clientId: 'fixture-admin-message' });
  await service.execute(owner, { type: 'member.remove', userId: restricted.userId, action: 'session-block' });
  const starts = Date.now() + 24 * 60 * 60 * 1000;
  await service.execute(owner, { type: 'schedule.save', title: 'Next community conversation', description: 'A fictional schedule for editing, cancellation, and pending-state checks.', startsAt: new Date(starts).toISOString(), endsAt: new Date(starts + 60 * 60 * 1000).toISOString() });
}

export async function createUiReviewFixture({ denyBrowserCapture = false, metadataFile = join(fixtureRoot, 'running.json'), faultFilePath = join(fixtureRoot, 'faults.json') } = {}) {
  // Fixed, test-only document policy. It is never selected by a request, fault
  // file, browser setting, or production configuration.
  const captureDenialPolicy = 'camera=(), microphone=(), display-capture=()';
  const realMedia = process.env.UI_REVIEW_REAL_MEDIA === '1';
  let mediaSettings;
  if (realMedia) {
    // Do not merge the desktop app's environment into this fixture. Only the
    // local SFU transport settings cross this boundary; no Discord or session
    // credential is reused, printed, written to metadata, or sent upstream.
    const settings = parse(await readFile(join(projectRoot, '.env'), 'utf8'));
    const url = new URL(settings.LIVEKIT_INTERNAL_URL ?? 'http://127.0.0.1:7880');
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Real-media UI fixtures require a loopback HTTP LiveKit endpoint.');
    if (!settings.LIVEKIT_API_KEY || (settings.LIVEKIT_API_SECRET?.length ?? 0) < 32) throw new Error('Local LiveKit credentials are not configured for the UI fixture.');
    mediaSettings = { url: url.href, apiKey: settings.LIVEKIT_API_KEY, apiSecret: settings.LIVEKIT_API_SECRET };
  }
  const frontend = new URL(process.env.UI_REVIEW_FRONTEND ?? 'http://localhost:3210');
  if (frontend.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(frontend.hostname)) throw new Error('UI fixture frontend must be loopback HTTP.');
  await mkdir(fixtureRoot, { recursive: true });
  const runRoot = await mkdtemp(join(fixtureRoot, 'run-'));
  const dataDir = join(runRoot, 'data');
  const faultFile = faultFilePath;
  try { await writeFile(faultFile, '{}\n', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let lastFlags = {}, dropConsumed = false;
  const flags = async () => {
    try {
      const parsed = JSON.parse(await readFile(faultFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lastFlags = parsed;
    } catch {}
    if (lastFlags.dropFirstChatResponse !== true) dropConsumed = false;
    return lastFlags;
  };
  const boundedDelay = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(30000, value)) : 0;
  const sockets = new Set();
  let backendOrigin, instance;
  const isApi = pathname => /^\/(?:api|rtc|healthz)(?:\/|$)/u.test(pathname);
  const unavailable = (response, message = 'The isolated UI fixture is not ready.') => {
    if (response.destroyed) return;
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: 'ui-fixture-unavailable', message }));
  };
  const destination = (request, base) => {
    const target = new URL(request.url ?? '/', base);
    target.protocol = base.protocol; target.host = base.host;
    return target;
  };
  const handleRequest = async (request, response) => {
    if (denyBrowserCapture) response.setHeader('permissions-policy', captureDenialPolicy);
    const pathname = (request.url ?? '/').split('?')[0];
    const api = isApi(pathname);
    if (!backendOrigin) { unavailable(response); return; }
    let body, command;
    if (pathname === '/api/commands' && request.method === 'POST') {
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 32768) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
      try { command = JSON.parse(body.toString('utf8')); } catch {}
    }
    const fault = await flags();
    if (pathname === '/api/commands' && fault.commandVerificationUnavailable === true) {
      const retry = Math.max(1, Math.ceil(boundedDelay(fault.verificationRetryAfterSeconds ?? 5)));
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(retry) });
      response.end(JSON.stringify({ error: 'verification-unavailable', message: 'Fictional verification outage for the local UI check.', retryAfterSeconds: retry }));
      return;
    }
    const base = api ? backendOrigin : frontend;
    const headers = { ...request.headers, host: base.host };
    // Fictional API cookies must never reach the actual app hosting the assets.
    if (!api) { delete headers.cookie; delete headers.authorization; if (headers.origin) headers.origin = frontend.origin; }
    const shouldDrop = command?.type === 'chat.send' && fault.dropFirstChatResponse === true && !dropConsumed;
    if (shouldDrop) dropConsumed = true;
    const responseDelay = command?.type === 'chat.send' ? boundedDelay(fault.chatResponseDelayMs)
      : command?.type === 'schedule.save' ? boundedDelay(fault.scheduleSaveResponseDelayMs) : 0;
    const target = forward(destination(request, base), { method: request.method, headers }, async result => {
      try {
      const successful = (result.statusCode ?? 500) >= 200 && (result.statusCode ?? 500) < 300;
      if (shouldDrop && successful) {
        result.resume();
        result.once('end', () => response.destroy()); // Real backend commit precedes the simulated lost response.
        return;
      }
      if (shouldDrop) dropConsumed = false;
      const outgoingHeaders = { ...result.headers };
      if (denyBrowserCapture) outgoingHeaders['permissions-policy'] = captureDenialPolicy;
      if (!api) delete outgoingHeaders['set-cookie'];
      if (responseDelay && successful) {
        const chunks = []; for await (const chunk of result) chunks.push(chunk);
        await delay(responseDelay);
        if (response.destroyed) return;
        response.writeHead(result.statusCode ?? 502, outgoingHeaders); response.end(Buffer.concat(chunks));
      } else { response.writeHead(result.statusCode ?? 502, outgoingHeaders); result.pipe(response); }
      } catch { response.destroy(); }
    });
    target.on('error', () => { if (!response.headersSent) unavailable(response, 'The isolated test connection was interrupted.'); else response.destroy(); });
    request.on('aborted', () => target.destroy());
    response.on('close', () => { if (!response.writableEnded) target.destroy(); });
    if (body) target.end(body); else request.pipe(target);
  };
  const proxy = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) unavailable(response, 'The isolated test request was interrupted.'); else response.destroy();
    });
  });
  // Only opt-in RTC upgrades reach this fixture's own authenticated gateway.
  // HMR/assets always reach the frontend without any fictional auth material.
  proxy.on('upgrade', (request, socket, head) => {
    const pathname = (request.url ?? '/').split('?')[0];
    const mediaUpgrade = realMedia && /^\/rtc(?:\/|$)/u.test(pathname);
    if (isApi(pathname) && !mediaUpgrade) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    if (mediaUpgrade && !backendOrigin) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    const base = mediaUpgrade ? backendOrigin : frontend;
    const headers = { ...request.headers, host: base.host };
    if (!mediaUpgrade) { delete headers.cookie; delete headers.authorization; if (headers.origin) headers.origin = frontend.origin; }
    const target = forward(destination(request, base), { method: request.method, headers });
    target.on('upgrade', (result, remote, upstreamHead) => {
      socket.write(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\n`);
      for (let index = 0; index < result.rawHeaders.length; index += 2) if (mediaUpgrade || result.rawHeaders[index].toLowerCase() !== 'set-cookie') socket.write(`${result.rawHeaders[index]}: ${result.rawHeaders[index + 1]}\r\n`);
      socket.write('\r\n'); if (upstreamHead.length) socket.write(upstreamHead); if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      remote.on('close', () => socket.destroy()); socket.on('close', () => remote.destroy());
      socket.pipe(remote).pipe(socket);
    });
    target.on('response', result => { socket.end(`HTTP/1.1 ${result.statusCode ?? 502} Proxy response\r\nConnection: close\r\n\r\n`); result.resume(); });
    target.on('error', () => socket.destroy()); target.end();
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const port = await listen(proxy);
  const fixtureUrl = `http://${host}:${port}`;
  try {
    instance = await createApp(previewConfig(fixtureUrl, dataDir, mediaSettings), { disableFrontend: true, quiet: true,
      fetch: async () => { throw new Error('Provider requests are disabled in the isolated UI fixture.'); } });
    // Keep actual domain policy/commands intact. Media effects are outside this
    // default UI fixture. The opt-in fixture uses only its own isolated state,
    // so its real media effects target its newly generated room name.
    if (!realMedia) {
      for (const method of ['reconcile', 'remove', 'closeRoom', 'mute', 'ensureRoom']) instance.media[method] = noMedia;
      instance.media.health = async () => false;
    }
    if (process.env.UI_REVIEW_START_CLOSED !== '1') await seed(instance.service);
    backendOrigin = new URL(await instance.app.listen({ host, port: 0 }));
    const metadata = { fixtureUrl, pid: process.pid, faultFile, realMedia, denyBrowserCapture };
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
    const inspectMedia = async () => {
      // Read only this fixture's brand-new store. Never accepts room IDs or
      // paths from the caller and never joins a room or captures any media.
      const state = instance.service.store.read();
      if (state.admissions.some(item => !item.userId.startsWith('preview-') && !item.userId.startsWith('fixture-'))) throw new Error('Unexpected non-fictional fixture identity.');
      const leases = instance.media.guard.snapshot();
      const reservations = state.shares ?? [];
      const reservationStatuses = {};
      for (const reservation of reservations) reservationStatuses[reservation.status] = (reservationStatuses[reservation.status] ?? 0) + 1;
      let participants = [], sfuRoomExists = false;
      if (realMedia && state.live?.roomName) {
        const api = new RoomServiceClient(mediaSettings.url, mediaSettings.apiKey, mediaSettings.apiSecret, { requestTimeout: 5 });
        try { participants = await api.listParticipants(state.live.roomName); sfuRoomExists = true; }
        catch (error) { if (error?.code !== 'not_found' && error?.status !== 404 && error?.statusCode !== 404) throw error; }
      }
      const tracks = participants.flatMap(participant => participant.tracks);
      return {
        capturedAt: new Date().toISOString(), ok: true, fictionalOnly: true, fixture: fixtureUrl,
        realMedia, denyBrowserCapture, roomOpen: !!state.live, roomState: state.live?.state ?? 'closed',
        sfuRoomExists, sfuParticipants: participants.length,
        sfuTracks: Object.fromEntries(['MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'].map(source => [source, tracks.filter(track => track.source === TrackSource[source]).length])),
        publicationLeases: { total: leases.length, pending: leases.filter(lease => !lease.published).length, published: leases.filter(lease => lease.published).length, bySource: Object.fromEntries(['microphone', 'screen_share', 'screen_share_audio'].map(source => [source, leases.filter(lease => lease.source === source).length])) },
        applicationReservations: { total: reservations.length, statuses: reservationStatuses, stopping: state.stoppingShares.length },
        microphoneOwnership: { total: Object.keys(state.microphoneOwners).length, fictionalOwnerOwnsMicrophone: !!state.microphoneOwners['preview-owner'] },
        cameraOrMicrophoneCaptureUsedByProbe: false,
      };
    };
    let stopping;
    const stop = () => stopping ??= (async () => {
      try {
        // Defensive cleanup is confined to this fresh database's room. The
        // real desktop application's room state is never read or addressed.
        if (realMedia) await instance.service.execute({ userId: 'preview-owner', displayName: 'Fixture cleanup', deviceId: 'fixture-cleanup', isAdmin: true, isOwner: true }, { type: 'session.end' });
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolveClose => proxy.close(resolveClose));
        await instance.app.close();
      }
    })();
    return { ...metadata, inspectMedia, stop };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    if (instance) await instance.app.close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const fixture = await createUiReviewFixture();
    console.log(JSON.stringify({ fixtureUrl: fixture.fixtureUrl, pid: fixture.pid, faultFile: fixture.faultFile, realMedia: fixture.realMedia }));
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      void fixture.stop().then(() => process.exit(0), () => { console.error('Isolated UI fixture cleanup failed. Private transport details were not logged.'); process.exit(1); });
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('disconnect', stop);
  } catch {
    console.error('Isolated UI fixture startup failed. Private configuration and transport details were not logged.');
    process.exitCode = 1;
  }
}

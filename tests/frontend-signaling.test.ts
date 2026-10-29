import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { handleRtcUpgrade } from '../frontend/server/rtc-handler.ts';
import { connectSignalingBridge, SignalingConnectionError, type SignalingBridgeOptions } from '../frontend/server/signaling-bridge.ts';

const backend = { origin: 'https://fixed-gateway.example.test', secret: 'fixture-only-proxy-secret-0123456789' };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await wait(10); }
  assert.fail('Signaling fixture did not reach the expected state.');
}
const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `ws://127.0.0.1:${address.port}`;
};

async function fixture(options: { deny?: boolean; initial?: boolean; failUpgrade?: boolean; limits?: SignalingBridgeOptions['limits'] } = {}) {
  const upstreamHttp = createServer(), frontendHttp = createServer();
  const upstreamWs = new WebSocketServer({ noServer: true }), frontendWs = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const sockets = new Set<Socket>();
  for (const server of [upstreamHttp, frontendHttp]) server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const peers = new Set<WebSocket>();
  const observations: { target?: URL; headers?: import('node:http').IncomingHttpHeaders; accepted: number; upstreamClosed: number } = { accepted: 0, upstreamClosed: 0 };
  upstreamHttp.on('upgrade', (request, socket, head) => {
    observations.headers = request.headers;
    if (options.deny || request.headers.origin !== 'https://app.example.test' || request.headers.cookie !== 'session=fixture') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
    }
    upstreamWs.handleUpgrade(request, socket, head, peer => {
      peers.add(peer); peer.on('error', () => {});
      peer.once('close', () => { peers.delete(peer); observations.upstreamClosed++; });
      if (options.initial) { peer.send('initial join', { binary: false }); peer.send(Buffer.from([0, 128, 255]), { binary: true }); }
      peer.on('message', (data, binary) => peer.send(data, { binary }));
    });
  });
  const upstreamUrl = await listen(upstreamHttp);
  frontendHttp.on('upgrade', (incoming, socket, head) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
    const request = new Request('https://app.example.test' + incoming.url, { headers });
    void handleRtcUpgrade(request, async (handler, settings) => {
      if (options.failUpgrade) throw new Error('Fixture upgrade failed without exposing upstream details.');
      assert.equal(settings?.maxPayload, 512 * 1024);
      // Deliberately let initial upstream data arrive before browser acceptance.
      await wait(20);
      await new Promise<void>((resolve, reject) => {
        try { frontendWs.handleUpgrade(incoming, socket, head, peer => { observations.accepted++; peers.add(peer); peer.on('error', () => {}); peer.once('close', () => peers.delete(peer)); void Promise.resolve(handler(peer)).then(resolve, reject); }); }
        catch (error) { reject(error); }
      });
      return new Response(null, { status: 204 });
    }, { backend, limits: options.limits, connect: (target, settings) => {
      observations.target = new URL(target);
      return new WebSocket(upstreamUrl + target.pathname + target.search, settings);
    } }).then(async response => {
      if (response.status === 204 || socket.destroyed) return;
      const body = await response.text();
      socket.end(`HTTP/1.1 ${response.status} Error\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    }).catch(() => socket.destroy());
  });
  const frontendUrl = await listen(frontendHttp);
  return { observations, peers, frontendUrl, client(query = '', origin = 'https://app.example.test') {
    const peer = new WebSocket(frontendUrl + '/rtc' + query, { headers: { origin, cookie: 'session=fixture', 'x-stage-proxy': 'caller-spoof', authorization: 'Bearer fixture' } });
    peer.on('error', () => {}); return peer;
  }, async close() {
    for (const peer of peers) peer.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all([upstreamHttp, frontendHttp].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    upstreamWs.close(); frontendWs.close();
  } };
}

test('Vercel signaling bridge preserves early join frames, binary/text, original authority and query credentials', async () => {
  const f = await fixture({ initial: true });
  const client = f.client('?access_token=fixture%2Btoken%2F%3D&reconnect=1');
  const messages: Array<{ data: Buffer; binary: boolean }> = [];
  client.on('message', (data, binary) => messages.push({ data: Buffer.from(data as Buffer), binary }));
  try {
    await once(client, 'open'); await until(() => messages.length === 2);
    assert.equal(messages[0]!.data.toString(), 'initial join'); assert.equal(messages[0]!.binary, false);
    assert.deepEqual(messages[1], { data: Buffer.from([0, 128, 255]), binary: true });
    assert.equal(f.observations.target?.origin, 'wss://fixed-gateway.example.test');
    assert.equal(f.observations.target?.pathname, '/rtc');
    assert.equal(f.observations.target?.search, '?access_token=fixture%2Btoken%2F%3D&reconnect=1');
    assert.equal(f.observations.headers?.origin, 'https://app.example.test');
    assert.equal(f.observations.headers?.cookie, 'session=fixture');
    assert.equal(f.observations.headers?.authorization, 'Bearer fixture');
    assert.equal(f.observations.headers?.['x-stage-proxy'], backend.secret);
    assert.equal(f.observations.headers?.['x-pinggy-no-screen'], '1');
    client.send('client text', { binary: false }); client.send(Buffer.from([1, 0, 254]), { binary: true });
    await until(() => messages.length === 4);
    assert.equal(messages[2]!.data.toString(), 'client text'); assert.equal(messages[2]!.binary, false);
    assert.deepEqual(messages[3], { data: Buffer.from([1, 0, 254]), binary: true });
    const closed = once(client, 'close'); client.close(1000); await closed;
    await until(() => f.observations.upstreamClosed === 1);
  } finally { client.terminate(); await f.close(); }
});

test('upstream admission denial or a foreign browser Origin rejects before accepting the browser WebSocket', async () => {
  for (const denied of [true, false]) {
    const f = await fixture({ deny: denied });
    const client = f.client('', denied ? 'https://app.example.test' : 'https://untrusted.example.test');
    try {
      const status = await new Promise<number | undefined>(resolve => client.once('unexpected-response', (request, response) => { resolve(response.statusCode); response.destroy(); request.destroy(); }));
      assert.equal(status, 403); assert.equal(f.observations.accepted, 0);
      if (!denied) assert.equal(f.observations.headers?.origin, 'https://untrusted.example.test');
    } finally { client.terminate(); await f.close(); }
  }
});

test('browser upgrade failure and upstream socket closure clean both signaling directions', async () => {
  const failed = await fixture({ failUpgrade: true }); const rejected = failed.client();
  try {
    const status = await new Promise<number | undefined>(resolve => rejected.once('unexpected-response', (request, response) => { resolve(response.statusCode); response.destroy(); request.destroy(); }));
    assert.equal(status, 502); await until(() => failed.observations.upstreamClosed === 1);
  } finally { rejected.terminate(); await failed.close(); }
  const f = await fixture(); const client = f.client();
  try {
    await once(client, 'open');
    const closed = once(client, 'close');
    [...f.peers].find(peer => peer !== client)!.close(1008, 'Fixture revocation');
    const [code] = await closed; assert.equal(code, 1008);
  } finally { client.terminate(); await f.close(); }
});

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Array<{ data: Buffer; binary?: boolean }> = [];
  closedWith: number | undefined;
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  send(data: Buffer, options: { binary?: boolean }, callback?: (error?: Error) => void) { this.sent.push({ data, binary: options.binary }); callback?.(); }
  close(code: number) { this.closedWith = code; this.readyState = WebSocket.CLOSED; this.emit('close', code, Buffer.alloc(0)); }
  terminate() { this.close(1006); }
  asWebSocket() { return this as unknown as WebSocket; }
}
function fakeOptions(upstream: FakeSocket, limits: SignalingBridgeOptions['limits'] = {}): SignalingBridgeOptions {
  return { target: new URL('wss://fixed-gateway.example.test/rtc'), headers: {}, limits,
    connect: () => { queueMicrotask(() => upstream.open()); return upstream.asWebSocket(); } };
}

test('early signaling queues, socket backpressure and individual payloads are bounded', async () => {
  const pending = new FakeSocket(); await connectSignalingBridge(fakeOptions(pending, { maxPendingMessages: 2 }));
  for (let index = 0; index < 3; index++) pending.emit('message', Buffer.from('join'), false);
  assert.equal(pending.closedWith, 1013);
  const upstream = new FakeSocket(); const bridge = await connectSignalingBridge(fakeOptions(upstream, { maxBufferedBytes: 8 }));
  const client = new FakeSocket(); client.open(); client.bufferedAmount = 7; bridge.attach(client.asWebSocket());
  upstream.emit('message', Buffer.from('hi'), true);
  assert.equal(client.closedWith, 1013); assert.equal(upstream.closedWith, 1013);
  const large = new FakeSocket(); const largeBridge = await connectSignalingBridge(fakeOptions(large, { maxPayload: 4 }));
  const sender = new FakeSocket(); sender.open(); largeBridge.attach(sender.asWebSocket()); sender.emit('message', Buffer.alloc(5), true);
  assert.equal(sender.closedWith, 1009); assert.equal(large.closedWith, 1009);
});

test('handshake cancellation, handoff timeout and function lifetime leave no open upstream', async () => {
  const controller = new AbortController(), cancelled = new FakeSocket();
  const pending = connectSignalingBridge({ ...fakeOptions(cancelled), connect: () => cancelled.asWebSocket(), signal: controller.signal });
  controller.abort(); await assert.rejects(pending, error => error instanceof SignalingConnectionError && error.status === 400);
  assert.equal(cancelled.readyState, WebSocket.CLOSED);
  const timed = new FakeSocket();
  const deadline = connectSignalingBridge({ ...fakeOptions(timed, { handshakeTimeoutMs: 5 }), connect: () => timed.asWebSocket() });
  await Promise.all([assert.rejects(deadline, error => error instanceof SignalingConnectionError && error.status === 504), wait(10)]);
  const orphan = new FakeSocket(); await connectSignalingBridge(fakeOptions(orphan, { handoffTimeoutMs: 5 }));
  await wait(10); assert.equal(orphan.readyState, WebSocket.CLOSED);
  const upstream = new FakeSocket(); const bridge = await connectSignalingBridge(fakeOptions(upstream, { lifetimeMs: 5 }));
  const client = new FakeSocket(); client.open(); bridge.attach(client.asWebSocket());
  await wait(10); assert.equal(upstream.closedWith, 1012); assert.equal(client.closedWith, 1012);
  const delayed = new FakeSocket(); const delayedBridge = await connectSignalingBridge(fakeOptions(delayed, { lifetimeMs: 30 }));
  await wait(20); const delayedClient = new FakeSocket(); delayedClient.open(); delayedBridge.attach(delayedClient.asWebSocket());
  await wait(15); assert.equal(delayedClient.closedWith, 1012, 'The deadline includes time spent waiting to accept the browser.');
});

test('ordinary HTTP cannot open a signaling socket or choose an arbitrary upstream', async () => {
  let contacted = false;
  const response = await handleRtcUpgrade(new Request('https://app.example.test/rtc?target=https://untrusted.example.test'), async () => { throw new Error('Upgrade must not run.'); }, {
    backend, connect: () => { contacted = true; throw new Error('Upstream must not run.'); },
  });
  assert.equal(response.status, 426); assert.equal(contacted, false); assert.equal(response.headers.get('cache-control'), 'no-store');
});

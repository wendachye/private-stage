import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { ApiError, request, sendCommand, type Bootstrap } from '../frontend/client/api.ts';
import { accessFailure, readRoomState, RoomAccessBoundary, roomKey, watchRoomEvents } from '../frontend/client/room-access.ts';
import type { RoomSnapshot } from '../shared/types.ts';

const boot = { deviceId: 'browser-one', auth: { status: 'authenticated', user: { userId: 'account-one' } } } as Bootstrap;
const key = roomKey(boot);
const snapshot = (revision: number, userId = 'account-one', deviceId = 'browser-one') => ({
  revision, self: { userId, deviceId }, messages: [{ id: 'private-message', body: 'Private session content' }],
}) as unknown as RoomSnapshot;

test('API preserves server access error codes and passes query cancellation through fetch', async () => {
  const original = globalThis.fetch;
  const abort = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, options) => {
    receivedSignal = options?.signal;
    return Response.json({ error: 'nonmember', message: 'Membership ended.' }, { status: 403 });
  };
  try {
    await assert.rejects(request('/api/state', undefined, abort.signal), reason => reason instanceof ApiError && reason.code === 'nonmember' && reason.status === 403);
    assert.equal(receivedSignal, abort.signal);
  } finally { globalThis.fetch = original; }
});

test('API retains the full valid verification cooldown and ignores invalid retry values', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: 'verification-unavailable', message: 'Wait for verification', retryAfterSeconds: 74.5 }, { status: 503, headers: { 'Retry-After': '90' } });
    await assert.rejects(request('/api/commands', {}), reason => reason instanceof ApiError && reason.retryAfterSeconds === 90);
    globalThis.fetch = async () => Response.json({ error: 'verification-unavailable', retryAfterSeconds: -10 }, { status: 503, headers: { 'Retry-After': 'NaN' } });
    await assert.rejects(request('/api/commands', {}), reason => reason instanceof ApiError && reason.retryAfterSeconds === undefined);
  } finally { globalThis.fetch = original; }
});

test('access recovery distinguishes expired membership from an ordinary denied action or service outage', () => {
  assert.equal(accessFailure(new ApiError('Expired', 401, 'authorization-revoked')), 'signed-out');
  assert.equal(accessFailure(new ApiError('Not a member', 403, 'nonmember')), 'nonmember');
  assert.equal(accessFailure(new ApiError('Cannot verify', 503, 'verification-unavailable')), 'verification-unavailable');
  assert.equal(accessFailure(new ApiError('Only admins', 403, 'forbidden')), undefined);
  assert.equal(accessFailure(new ApiError('SFU unavailable', 503, 'media-unavailable')), undefined);
  assert.equal(accessFailure(new TypeError('Network error')), undefined);
});

test('a rejected fresh-sensitive command reports verification failure without treating the session as ended', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'verification-unavailable', message: 'Discord is rate limiting verification. Please try again shortly.' }, { status: 503 });
  try {
    await assert.rejects(sendCommand({ type: 'session.open', mode: 'stage', title: 'Preserve this draft' }), reason => {
      assert.ok(reason instanceof ApiError);
      assert.equal(reason.message, 'Discord is rate limiting verification. Please try again shortly.');
      assert.equal(accessFailure(reason, 'command'), undefined);
      // The ordinary authoritative read still closes private state if membership cannot be verified.
      assert.equal(accessFailure(reason, 'read'), 'verification-unavailable');
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test('command failures still revoke private access for expired authorization, nonmembers, and account changes', () => {
  assert.equal(accessFailure(new ApiError('Expired', 401, 'authorization-revoked'), 'command'), 'signed-out');
  assert.equal(accessFailure(new ApiError('Changed', 401, 'session-changed'), 'command'), 'signed-out');
  assert.equal(accessFailure(new ApiError('Not a member', 403, 'nonmember'), 'command'), 'nonmember');
  assert.equal(accessFailure(new ApiError('Denied', 401, 'verification-unavailable'), 'command'), 'verification-unavailable');
});

test('both initial and refreshed room reads reject a cookie/account change before caching private data', async () => {
  const original = globalThis.fetch;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  globalThis.fetch = async () => Response.json(snapshot(1, 'another-account'));
  try {
    await assert.rejects(queries.fetchQuery({ queryKey: key, queryFn: ({ signal }) => readRoomState(boot, signal) }), reason => reason instanceof ApiError && reason.code === 'session-changed');
    assert.equal(queries.getQueryData(key), undefined);
    globalThis.fetch = async () => Response.json(snapshot(2));
    const next = await queries.fetchQuery({ queryKey: key, queryFn: ({ signal }) => readRoomState(boot, signal) });
    assert.equal(next.self.userId, 'account-one');
  } finally { globalThis.fetch = original; queries.clear(); }
});

test('access loss cancels pending private reads and late results cannot restore cleared content', async () => {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const boundary = new RoomAccessBoundary(queries);
  let finish!: (value: RoomSnapshot) => void;
  let aborted = false;
  const pending = queries.fetchQuery({ queryKey: key, queryFn: ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise<RoomSnapshot>(resolve => { finish = resolve; });
  } }).catch(() => undefined);
  boundary.reset();
  finish(snapshot(5));
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(queries.getQueryData(key), undefined);
  queries.clear();
});

test('late commands from before sign-out cannot recreate private room cache after a new sign-in', () => {
  const queries = new QueryClient();
  const boundary = new RoomAccessBoundary(queries);
  const oldAccess = boundary.capture();
  boundary.accept(oldAccess, key, snapshot(10));
  assert.equal(queries.getQueryData<RoomSnapshot>(key)?.revision, 10);
  const newAccess = boundary.reset();
  boundary.accept(oldAccess, key, snapshot(12));
  assert.equal(queries.getQueryData(key), undefined);
  boundary.accept(newAccess, key, snapshot(11));
  boundary.accept(oldAccess, key, snapshot(13));
  boundary.accept(newAccess, key, snapshot(9));
  assert.equal(queries.getQueryData<RoomSnapshot>(key)?.revision, 11);
  boundary.accept(newAccess, key, snapshot(14, 'another-account'));
  boundary.accept(newAccess, key, snapshot(14, 'account-one', 'another-device'));
  assert.equal(queries.getQueryData<RoomSnapshot>(key)?.revision, 11);
  queries.clear();
});

class FakeEvents extends EventTarget {
  onopen: EventSource['onopen'] = null;
  onmessage: EventSource['onmessage'] = null;
  onerror: EventSource['onerror'] = null;
  closed = 0;
  close() { this.closed += 1; }
  emit(name: string) {
    const event = new Event(name);
    this.dispatchEvent(event);
    const callback = name === 'open' ? this.onopen : name === 'error' ? this.onerror : name === 'message' ? this.onmessage : null;
    callback?.call(this as unknown as EventSource, event as MessageEvent);
  }
}

test('explicit SSE access end closes reconnection and clears private cache before any later event', () => {
  const queries = new QueryClient();
  const boundary = new RoomAccessBoundary(queries);
  boundary.accept(boundary.capture(), key, snapshot(1));
  const events = new FakeEvents();
  const connections: boolean[] = [];
  let refreshes = 0, ended = 0;
  const stop = watchRoomEvents(events, { connected: value => connections.push(value), refresh: () => { refreshes += 1; },
    accessEnded: () => { ended += 1; boundary.reset(); } });
  events.emit('open');
  events.emit('invalidate');
  events.emit('access-ended');
  events.emit('invalidate');
  events.emit('open');
  events.emit('error');
  events.emit('access-ended');
  assert.equal(events.closed, 1);
  assert.equal(ended, 1);
  assert.equal(refreshes, 2);
  assert.deepEqual(connections, [true, false]);
  assert.equal(queries.getQueryData(key), undefined);
  stop();
  queries.clear();
});

test('a transient SSE error requests HTTP fallback without treating it as lost membership', () => {
  const events = new FakeEvents();
  const connections: boolean[] = [];
  let refreshes = 0, ended = 0;
  const stop = watchRoomEvents(events, { connected: value => connections.push(value), refresh: () => { refreshes += 1; }, accessEnded: () => { ended += 1; } });
  events.emit('open');
  events.emit('error');
  events.emit('open');
  assert.deepEqual(connections, [true, false, true]);
  assert.equal(refreshes, 3);
  assert.equal(ended, 0);
  assert.equal(events.closed, 0);
  stop();
});

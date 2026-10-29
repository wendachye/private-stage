import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionState } from 'livekit-client';
import { prepareMediaRoom } from '../frontend/client/media.tsx';

test('joining a new session disconnects a still-connected or reconnecting previous SDK room first', async () => {
  for (const state of [ConnectionState.Connected, ConnectionState.Reconnecting, ConnectionState.Connecting]) {
    let disconnects = 0;
    const room = { state, name: 'previous-room', disconnect: async () => { disconnects++; } };
    assert.equal(await prepareMediaRoom(room, 'new-room', () => true), true);
    assert.equal(disconnects, 1);
  }
});

test('a matching active room or an already disconnected SDK room is preserved', async () => {
  for (const state of [ConnectionState.Connected, ConnectionState.Reconnecting, ConnectionState.Disconnected]) {
    let disconnects = 0;
    const room = { state, name: state === ConnectionState.Disconnected ? 'previous-room' : 'current-room', disconnect: async () => { disconnects++; } };
    assert.equal(await prepareMediaRoom(room, 'current-room', () => true), true);
    assert.equal(disconnects, 0);
  }
});

test('session or device changes while disconnecting prevent the next connection phase', async () => {
  let active = true, finish!: () => void;
  const room = { state: ConnectionState.Connected, name: 'previous-room', disconnect: () => new Promise<void>(resolve => { finish = resolve; }) };
  const pending = prepareMediaRoom(room, 'new-room', () => active);
  active = false; finish();
  assert.equal(await pending, false);
});

test('a superseded join never disconnects a room owned by the current session', async () => {
  let disconnects = 0;
  const room = { state: ConnectionState.Connected, name: 'current-room', disconnect: async () => { disconnects++; } };
  assert.equal(await prepareMediaRoom(room, 'old-room', () => false), false);
  assert.equal(disconnects, 0);
});

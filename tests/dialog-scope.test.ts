import test from 'node:test';
import assert from 'node:assert/strict';
import { DialogScopeGate } from '../frontend/client/dialog-scope.ts';

test('identity, device, session, or authority changes invalidate an old confirmation before it can run', () => {
  const gate = new DialogScopeGate();
  const initial = ['owner', 'device-a', 'session-a', true];
  for (const next of [['member', 'device-a', 'session-a', true], ['owner', 'device-b', 'session-a', true], ['owner', 'device-a', 'session-b', true], ['owner', 'device-a', 'session-a', false]]) {
    gate.setScope(JSON.stringify(initial));
    const pending = gate.open();
    gate.setScope(JSON.stringify(next));
    assert.equal(gate.current(pending), false);
    assert.equal(gate.close(pending), false);
  }
});

test('an older async dialog completion cannot close or update a replacement opened in the same room', () => {
  const gate = new DialogScopeGate();
  gate.setScope('same-account-and-session');
  const old = gate.open(), replacement = gate.open();
  assert.equal(gate.close(old), false);
  assert.equal(gate.current(replacement), true);
  assert.equal(gate.close(replacement), true);
  assert.equal(gate.current(replacement), false);
});

test('ordinary rerenders retain the current dialog while tickets remain immutable', () => {
  const gate = new DialogScopeGate();
  gate.setScope('current');
  const ticket = gate.open();
  gate.setScope('current');
  assert.equal(gate.current(ticket), true);
  assert.equal(Object.isFrozen(ticket), true);
  assert.throws(() => Object.assign(ticket, { scope: 'other' }));
});

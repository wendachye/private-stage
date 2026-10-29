import test from 'node:test';
import assert from 'node:assert/strict';
import { StageService } from '../backend/src/domain/stage-service.ts';
import { OpenedSessionJoinGate, matchesOpenedSessionJoin } from '../frontend/client/opened-session-join.ts';
import type { Principal } from '../shared/types.ts';

const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'opening-device', isOwner: true, isAdmin: true };
const fixture = () => new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });

test('automatic media join waits for the opening response snapshot and consumes exactly once despite later SSE revisions', async () => {
  const service = fixture();
  try {
    const gate = new OpenedSessionJoinGate(); gate.setScope('owner/device/auth/admin');
    const capture = gate.capture(), closed = service.snapshot(owner);
    const opened = (await service.execute(owner, { type: 'session.open', mode: 'stage' })).snapshot;
    assert.equal(gate.queue(capture, opened), true);
    assert.equal(gate.take(closed), null, 'An older closed-room render cannot consume a successful opening ticket.');
    await service.execute(owner, { type: 'room.waiting-audio', enabled: true });
    const authoritative = service.snapshot(owner), ticket = gate.take(authoritative);
    assert.ok(ticket);
    assert.equal(ticket.sessionId, opened.session?.id);
    assert.equal(matchesOpenedSessionJoin(ticket, authoritative), true);
    assert.equal(Object.isFrozen(ticket), true);
    assert.equal(Object.isFrozen(capture), true);
    assert.equal(gate.take(authoritative), null, 'A later render cannot start a second media connection.');
  } finally { service.close(); }
});

test('refreshes and other opening devices do not automatically join without their own successful opening ticket', async () => {
  const service = fixture();
  try {
    const opened = (await service.execute(owner, { type: 'session.open', mode: 'stage' })).snapshot;
    const freshPage = new OpenedSessionJoinGate(); freshPage.setScope('owner/device/auth/admin');
    assert.equal(freshPage.take(opened), null);
    const secondDevice = { ...owner, deviceId: 'other-device' };
    const second = service.snapshot(secondDevice);
    assert.equal(second.self.admission, null);
    assert.equal(freshPage.queue(freshPage.capture(), second), false);
    assert.equal(freshPage.take(second), null);
  } finally { service.close(); }
});

test('account, device, authority, and ABA scope changes invalidate delayed opening responses', async () => {
  const service = fixture();
  try {
    const opened = (await service.execute(owner, { type: 'session.open', mode: 'stage' })).snapshot;
    for (const replacement of ['member/device/auth/member', 'owner/another-device/auth/admin', 'owner/device/auth/member']) {
      const gate = new OpenedSessionJoinGate(); gate.setScope('original');
      const capture = gate.capture(); gate.setScope(replacement); gate.setScope('original');
      assert.equal(gate.queue(capture, opened), false);
      assert.equal(gate.take(opened), null);
    }
    const gate = new OpenedSessionJoinGate(); gate.setScope('current');
    const capture = gate.capture(); assert.equal(gate.queue(capture, opened), true);
    const withoutAuthority = structuredClone(opened); withoutAuthority.self.isAdmin = false; withoutAuthority.self.isOwner = false;
    assert.equal(gate.take(withoutAuthority), null);
    assert.equal(gate.take(opened), null, 'Restored authority cannot revive an earlier automatic join.');
    const cleared = gate.capture(); gate.clear();
    assert.equal(gate.queue(cleared, opened), false);
  } finally { service.close(); }
});

test('ending, replacing, or revoking the opened admission cancels the queued media connection', async () => {
  const service = fixture();
  try {
    const opened = (await service.execute(owner, { type: 'session.open', mode: 'stage' })).snapshot;
    for (const variant of ['ended', 'replacement', 'revoked', 'no-state']) {
      const gate = new OpenedSessionJoinGate(); gate.setScope('current');
      assert.equal(gate.queue(gate.capture(), opened), true);
      const next = structuredClone(opened); next.revision++;
      if (variant === 'ended') next.session = null;
      if (variant === 'replacement') next.session!.id = 'new-session';
      if (variant === 'revoked') next.self.admission!.revoked = true;
      assert.equal(gate.take(variant === 'no-state' ? null : next), null);
      assert.equal(gate.take(opened), null);
    }
  } finally { service.close(); }
});

test('an older media join can finish without consuming the new room automatic join, while an ended room still cancels it', async () => {
  const service = fixture();
  try {
    const opened = (await service.execute(owner, { type: 'session.open', mode: 'stage' })).snapshot;
    const gate = new OpenedSessionJoinGate(); gate.setScope('current');
    assert.equal(gate.queue(gate.capture(), opened), true);
    assert.equal(gate.take(opened, true), null, 'A busy connection must defer the new room ticket.');
    assert.equal(gate.take(opened, true), null);
    assert.ok(gate.take(opened, false));
    assert.equal(gate.take(opened, false), null);
    assert.equal(gate.queue(gate.capture(), opened), true);
    const ended = structuredClone(opened); ended.revision++; ended.session = null;
    assert.equal(gate.take(ended, true), null);
    assert.equal(gate.take(opened, false), null, 'Connection completion cannot join an ended room.');
  } finally { service.close(); }
});

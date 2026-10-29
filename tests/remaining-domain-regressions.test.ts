import test from 'node:test';
import assert from 'node:assert/strict';
import { StageService } from '../backend/src/domain/stage-service.ts';
import type { Principal } from '../shared/types.ts';

const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'owner-browser', isOwner: true, isAdmin: true };
const member = (deviceId = 'member-browser'): Principal => ({ userId: 'member', displayName: 'Member', deviceId, isOwner: false, isAdmin: false });

test('a member leaving their last room device removes their raised hand instead of leaving an unapprovable queue entry', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'qa' });
    const actor = member();
    await service.admit(actor);
    await service.execute(actor, { type: 'hand.set', raised: true });
    assert.equal(service.snapshot(owner).handRequests.length, 1);

    await service.execute(actor, { type: 'room.leave' });
    assert.equal(service.snapshot(owner).participants.some(person => person.userId === actor.userId), false);
    assert.deepEqual(service.snapshot(owner).handRequests, []);

    await service.admit(actor);
    assert.equal(service.snapshot(actor).participants.find(person => person.userId === actor.userId)?.hasHandRaised, false, 'A later join must start with no abandoned hand request.');
  } finally { service.close(); }
});

test('leaving one device retains an account hand request until its last admitted device leaves', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'qa' });
    const first = member(), second = member('member-second-browser');
    await service.admit(first);
    await service.admit(second);
    await service.execute(first, { type: 'hand.set', raised: true });

    await service.execute(first, { type: 'room.leave' });
    assert.equal(service.snapshot(owner).handRequests[0]?.userId, first.userId);
    assert.equal(service.snapshot(second).participants.find(person => person.userId === first.userId)?.hasHandRaised, true);

    await service.execute(second, { type: 'room.leave' });
    assert.deepEqual(service.snapshot(owner).handRequests, []);
  } finally { service.close(); }
});

test('a temporary media disconnect retains the admitted member hand request for reconnection', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'qa' });
    const actor = member(), admission = await service.admit(actor);
    await service.setConnection(admission.identity, true);
    await service.execute(actor, { type: 'hand.set', raised: true });
    await service.setConnection(admission.identity, false);
    assert.equal(service.snapshot(owner).handRequests[0]?.userId, actor.userId);
    assert.equal((await service.admit(actor)).id, admission.id);
  } finally { service.close(); }
});

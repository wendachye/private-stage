import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminPanel } from '../frontend/client/components.tsx';
import { StageService } from '../backend/src/domain/stage-service.ts';
import type { Principal } from '../shared/types.ts';

test('room management offers one labelled restore control for session blocks, persistent bans, or both', async () => {
  const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'owner-device', isOwner: true, isAdmin: true };
  const member: Principal = { userId: 'test-member', displayName: 'Test member', deviceId: 'member-device', isOwner: false, isAdmin: false };
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'stage', title: 'Restriction restore UI' });
    await service.admit(owner); await service.admit(member);
    const render = () => renderToStaticMarkup(createElement(AdminPanel, { state: service.snapshot(owner), command: command => service.execute(owner, command) }));
    await service.execute(owner, { type: 'member.remove', userId: member.userId, action: 'session-block' });
    let html = render();
    assert.ok(html.includes('Blocked this session'));
    assert.equal((html.match(/aria-label="Restore access for Test member"/g) ?? []).length, 1, 'A removed session-blocked member needs a discoverable restore button.');
    await service.execute(owner, { type: 'member.remove', userId: member.userId, action: 'ban' });
    html = render();
    assert.ok(html.includes('Banned'));
    assert.ok(html.includes('Blocked this session'));
    assert.equal((html.match(/aria-label="Restore access for Test member"/g) ?? []).length, 1, 'A doubly restricted member must not receive duplicate rows/buttons.');
    await service.execute(owner, { type: 'member.restore', userId: member.userId });
    html = render();
    assert.ok(html.includes('No restricted members.'));
    assert.equal(html.includes('Restore access for Test member'), false);
  } finally { service.close(); }
});

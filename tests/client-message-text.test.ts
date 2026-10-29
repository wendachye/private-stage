import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../frontend/components/ui/tooltip.tsx';
import { ChatPanel } from '../frontend/client/components.tsx';
import { StageService } from '../backend/src/domain/stage-service.ts';
import type { Principal } from '../shared/types.ts';

async function renderMessage(text: string, mentionUserIds: string[]) {
  const owner: Principal = { userId: 'ann-lee', displayName: 'Ann Lee', deviceId: 'owner-device', isOwner: true, isAdmin: true };
  const members = [{ userId: 'ann', displayName: 'Ann' }, { userId: 'bob', displayName: 'Bob (Ops)' }, { userId: 'wen', displayName: '文达' }];
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'stage', title: 'Isolated rendered mentions' });
    await service.admit(owner);
    for (const member of members) await service.admit({ ...member, deviceId: member.userId + '-device', isOwner: false, isAdmin: false });
    await service.execute(owner, { type: 'chat.send', text, mentionUserIds });
    const markup = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatPanel, { state: service.snapshot(owner), enabled: true, command: command => service.execute(owner, command) })));
    const body = markup.match(/<p class="message-body">([\s\S]*?)<\/p>/)?.[1];
    assert.ok(body, 'The real chat component must render the stored message.');
    return body;
  } finally { service.close(); }
}

test('rendered mentions prefer a complete overlapping name and highlight the full current viewer name', async () => {
  const body = await renderMessage('@Ann @Ann Lee', ['ann', 'ann-lee']);
  assert.equal(body, '<mark class="mention">@Ann</mark> <mark class="mention own">@Ann Lee</mark>');
});

test('rendered mention boundaries reject emails and longer words while preserving punctuation and Unicode names', async () => {
  const body = await renderMessage('@Ann, email@Ann @Annabelle @Bob (Ops)! @文达！ @文达同学', ['ann', 'bob', 'wen']);
  assert.equal((body.match(/<mark /g) ?? []).length, 3, 'Only the three complete visible mention tokens should be marked.');
  assert.ok(body.includes('<mark class="mention">@Ann</mark>,'));
  assert.ok(body.includes('email@Ann @Annabelle'));
  assert.ok(body.includes('<mark class="mention">@Bob (Ops)</mark>!'));
  assert.ok(body.includes('<mark class="mention">@文达</mark>！ @文达同学'));
});

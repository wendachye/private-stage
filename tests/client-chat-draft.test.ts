import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatDraftController, boundedChatInsertion, pruneChatMentions, shouldSendChatOnEnter } from '../frontend/client/chat-draft-controller.ts';
import { StageService } from '../backend/src/domain/stage-service.ts';
import type { Principal } from '../shared/types.ts';

const ann = { userId: 'ann', displayName: 'Ann' };
const anna = { userId: 'anna', displayName: 'Anna' };
const annLee = { userId: 'ann-lee', displayName: 'Ann Lee' };
const bob = { userId: 'bob', displayName: 'Bob (Ops)' };
const people = [ann, anna, annLee, bob];
const fixture = (scope = 'account/device/session') => {
  let ids = 0;
  return new ChatDraftController(scope, () => `client-${++ids}`);
};

test('emoji insertion rejects the whole UTF-16 pair when only one code unit remains', () => {
  assert.equal(boundedChatInsertion('abcd', '👍', 4, 4, 5), undefined);
  assert.deepEqual(boundedChatInsertion('abc', '👍', 3, 3, 5), { text: 'abc👍', caret: 5 });
});

test('a mention token is inserted completely or rejected without truncating its label', () => {
  assert.equal(boundedChatInsertion('Hello @', '@Bob (Ops) ', 6, 7, 15), undefined);
  assert.deepEqual(boundedChatInsertion('Hello @', '@Bob (Ops) ', 6, 7, 17), { text: 'Hello @Bob (Ops) ', caret: 17 });
});

test('selected text replacement uses the resulting limit and clamps its caret bounds', () => {
  assert.deepEqual(boundedChatInsertion('abOLDyz', '👍', 2, 5, 6), { text: 'ab👍yz', caret: 4 });
  assert.deepEqual(boundedChatInsertion('old', '@Ann ', -10, 100, 5), { text: '@Ann ', caret: 5 });
});

test('a pending send has an immutable payload and cannot clear a newer edited draft', () => {
  const draft = fixture();
  draft.setText('First message');
  const first = draft.beginSend(people)!;
  assert.equal(draft.beginSend(people), undefined, 'A second click must not start another request while this send is pending.');
  draft.mention(bob, 'Next message @Bob (Ops) ');
  assert.equal(first.payload.text, 'First message');
  assert.deepEqual(first.payload.mentionUserIds, []);
  assert.ok(Object.isFrozen(first.payload));
  assert.ok(Object.isFrozen(first.payload.mentionUserIds));
  draft.succeed(first);
  assert.equal(draft.getSnapshot().text, 'Next message @Bob (Ops) ');
  assert.deepEqual(draft.getSnapshot().mentionUserIds, ['bob']);
  assert.equal(draft.getSnapshot().sending, false);
});

test('an unchanged ambiguous retry keeps its client ID so a committed message is deduplicated', async () => {
  const draft = fixture();
  const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'device', isAdmin: true, isOwner: true };
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await service.execute(owner, { type: 'session.open', mode: 'stage', title: 'Isolated chat retry' });
    await service.admit(owner);
    draft.setText('Response may be lost');
    const first = draft.beginSend(people)!;
    await service.execute(owner, first.payload);
    draft.fail(first); // The real domain committed, but its HTTP response was lost.
    const retry = draft.beginSend(people)!;
    const result = await service.execute(owner, retry.payload);
    assert.equal(retry.payload.clientId, first.payload.clientId);
    assert.equal(result.snapshot.messages.length, 1);
    draft.succeed(retry);
    assert.deepEqual(draft.getSnapshot(), { text: '', mentionUserIds: [], sending: false });
    draft.setText('Response may be lost');
    const next = draft.beginSend(people)!;
    assert.notEqual(next.payload.clientId, first.payload.clientId, 'A newly composed identical message after acknowledgement is a new send.');
    assert.equal((await service.execute(owner, next.payload)).snapshot.messages.length, 2);
  } finally { service.close(); }
});

test('editing a failed draft makes a new message with a new retry ID', () => {
  const draft = fixture();
  draft.setText('Old draft');
  const first = draft.beginSend(people)!;
  draft.fail(first);
  draft.setText('Edited draft');
  const next = draft.beginSend(people)!;
  assert.notEqual(next.payload.clientId, first.payload.clientId);
  assert.equal(next.payload.text, 'Edited draft');
});

test('old completion after an identity or session reset cannot clear or unlock the replacement send', () => {
  const draft = fixture();
  draft.setText('Old private draft');
  const old = draft.beginSend(people)!;
  draft.reset('another-account/device/new-session');
  assert.deepEqual(draft.getSnapshot(), { text: '', mentionUserIds: [], sending: false });
  draft.setText('New private draft');
  const current = draft.beginSend(people)!;
  draft.fail(old);
  draft.succeed(old);
  assert.equal(draft.getSnapshot().text, 'New private draft');
  assert.equal(draft.getSnapshot().sending, true);
  assert.notEqual(old.payload.clientId, current.payload.clientId);
  draft.succeed(current);
  assert.equal(draft.getSnapshot().sending, false);
});

test('deleted and departed mention IDs are pruned before a send or retry', () => {
  const draft = fixture();
  draft.mention(ann, 'Hello @Ann ');
  draft.setText('Hello without mention');
  assert.deepEqual(draft.getSnapshot().mentionUserIds, []);
  draft.mention(bob, 'Hello @Bob (Ops) ');
  const send = draft.beginSend(people.filter(person => person.userId !== bob.userId))!;
  assert.deepEqual(send.payload.mentionUserIds, []);
  draft.fail(send);
  assert.deepEqual(draft.beginSend(people)!.payload.mentionUserIds, [], 'A departed mention must not silently return on a later retry.');
});

test('visible mention matching uses full current names, handles punctuation, and rejects prefixes and emails', () => {
  assert.deepEqual(pruneChatMentions('Hello @Anna, @Ann Lee and @Bob (Ops)!', ['ann', 'anna', 'ann-lee', 'bob', 'bob', 'departed'], people), ['anna', 'ann-lee', 'bob']);
  assert.deepEqual(pruneChatMentions('email@Ann and @Annabelle', ['ann'], people), []);
  assert.deepEqual(pruneChatMentions('(@Ann), thanks', ['ann'], people), ['ann']);
  const chinese = { userId: 'wen', displayName: '文达' };
  assert.deepEqual(pruneChatMentions('你好 @文达！', ['wen'], [chinese]), ['wen']);
  assert.deepEqual(pruneChatMentions('@文达同学', ['wen'], [chinese]), []);
});

test('IME confirmation Enter and Shift Enter never submit chat', () => {
  assert.equal(shouldSendChatOnEnter({ key: 'Enter' }), true);
  assert.equal(shouldSendChatOnEnter({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSendChatOnEnter({ key: 'Enter', isComposing: true }), false);
  assert.equal(shouldSendChatOnEnter({ key: 'Enter', nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldSendChatOnEnter({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(shouldSendChatOnEnter({ key: 'Enter', nativeEvent: { keyCode: 229 } }), false);
  assert.equal(shouldSendChatOnEnter({ key: 'a' }), false);
});

test('a same-scope reset retains the draft and store snapshots stay stable until an edit', () => {
  const draft = fixture();
  let changes = 0;
  const unsubscribe = draft.subscribe(() => { changes++; });
  const before = draft.getSnapshot();
  assert.equal(draft.getSnapshot(), before);
  draft.setText('Draft');
  const after = draft.getSnapshot();
  assert.notEqual(after, before);
  draft.reset('account/device/session');
  assert.equal(draft.getSnapshot(), after);
  draft.setText('Draft');
  assert.equal(changes, 1);
  unsubscribe();
  draft.setText('Another draft');
  assert.equal(changes, 1);
});

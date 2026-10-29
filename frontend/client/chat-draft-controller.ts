import type { Command } from '../../shared/types';

export interface ChatMentionCandidate { userId: string; displayName: string }
export interface ChatDraftSnapshot {
  readonly text: string;
  readonly mentionUserIds: readonly string[];
  readonly sending: boolean;
}
export type ChatSendPayload = Extract<Command, { type: 'chat.send' }> & { clientId: string; mentionUserIds: string[] };
export interface ChatDraftAttempt { readonly payload: Readonly<ChatSendPayload> }

/** Matches textarea maxLength (UTF-16 units) and never truncates an insertion. */
export function boundedChatInsertion(text: string, insertion: string, start: number, end: number, maxLength: number): { text: string; caret: number } | undefined {
  if (!Number.isFinite(maxLength) || maxLength < 0) return;
  const index = (value: number) => Math.min(text.length, Math.max(0, Number.isFinite(value) ? Math.trunc(value) : 0));
  const from = index(start), to = Math.max(from, index(end));
  const proposed = text.slice(0, from) + insertion + text.slice(to);
  if (proposed.length > maxLength) return;
  return { text: proposed, caret: from + insertion.length };
}

export function pruneChatMentions(text: string, selectedIds: readonly string[], participants: readonly ChatMentionCandidate[]): string[] {
  const byId = new Map(participants.map(person => [person.userId, person.displayName]));
  const names = [...new Set(byId.values())].filter(Boolean).sort((a, b) => b.length - a.length);
  const visible = new Set<string>();
  const word = (character: string | undefined) => !!character && /[\p{L}\p{N}_]/u.test(character);
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (word(Array.from(text.slice(0, at)).at(-1))) continue;
    // Prefer the complete current display name over an overlapping shorter
    // name: @Ann Lee must not also notify Ann. Labels are literal, not regex.
    const name = names.find(candidate => text.startsWith(candidate, at + 1)
      && !word(Array.from(text.slice(at + 1 + candidate.length))[0]));
    if (name) visible.add(name);
  }
  return [...new Set(selectedIds)].filter(id => {
    const name = byId.get(id);
    return name !== undefined && visible.has(name);
  });
}

export function shouldSendChatOnEnter(event: {
  key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.nativeEvent?.isComposing
    && event.keyCode !== 229 && event.nativeEvent?.keyCode !== 229;
}

/** Draft and send ownership are separate so editing can continue while a send is pending. */
export class ChatDraftController {
  private scope: string | null;
  private revision = 0;
  private value: ChatDraftSnapshot = Object.freeze({ text: '', mentionUserIds: Object.freeze([] as string[]), sending: false });
  private readonly listeners = new Set<() => void>();
  private readonly mentionNames = new Map<string, string>();
  private active?: { attempt: ChatDraftAttempt; revision: number };
  private lastSubmission?: { signature: string; clientId: string };

  constructor(scope: string | null = null, private readonly createId: () => string = () => crypto.randomUUID()) { this.scope = scope; }

  readonly getSnapshot = (): ChatDraftSnapshot => this.value;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setText(text: string): void {
    const participants = [...this.mentionNames].map(([userId, displayName]) => ({ userId, displayName }));
    this.edit(text, pruneChatMentions(text, this.value.mentionUserIds, participants));
  }

  mention(person: ChatMentionCandidate, nextText: string): void {
    this.mentionNames.set(person.userId, person.displayName);
    const selected = [...new Set([...this.value.mentionUserIds, person.userId])];
    const participants = [...this.mentionNames].map(([userId, displayName]) => ({ userId, displayName }));
    this.edit(nextText, pruneChatMentions(nextText, selected, participants));
  }

  reset(scope: string | null): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.revision++;
    this.active = undefined;
    this.lastSubmission = undefined;
    this.mentionNames.clear();
    this.publish('', [], false);
  }

  beginSend(participants: readonly ChatMentionCandidate[]): ChatDraftAttempt | undefined {
    if (this.active || !this.value.text.trim()) return;
    const mentions = pruneChatMentions(this.value.text, this.value.mentionUserIds, participants);
    this.edit(this.value.text, mentions);
    const text = this.value.text.trim();
    const signature = JSON.stringify([text, [...mentions].sort()]);
    const clientId = this.lastSubmission?.signature === signature ? this.lastSubmission.clientId : this.createId();
    this.lastSubmission = { signature, clientId };
    const payload: ChatSendPayload = { type: 'chat.send', text, mentionUserIds: [...mentions], clientId };
    Object.freeze(payload.mentionUserIds);
    Object.freeze(payload);
    const attempt: ChatDraftAttempt = Object.freeze({ payload });
    this.active = { attempt, revision: this.revision };
    this.publish(this.value.text, this.value.mentionUserIds, true);
    return attempt;
  }

  succeed(attempt: ChatDraftAttempt): void {
    const active = this.active;
    if (!active || active.attempt !== attempt) return;
    this.active = undefined;
    this.lastSubmission = undefined;
    if (active.revision === this.revision) {
      this.revision++;
      this.mentionNames.clear();
      this.publish('', [], false);
    } else this.publish(this.value.text, this.value.mentionUserIds, false);
  }

  fail(attempt: ChatDraftAttempt): void {
    if (this.active?.attempt !== attempt) return;
    this.active = undefined;
    this.publish(this.value.text, this.value.mentionUserIds, false);
  }

  private edit(text: string, mentionUserIds: readonly string[]): void {
    if (text === this.value.text && mentionUserIds.length === this.value.mentionUserIds.length && mentionUserIds.every((id, index) => id === this.value.mentionUserIds[index])) return;
    this.revision++;
    for (const id of this.mentionNames.keys()) if (!mentionUserIds.includes(id)) this.mentionNames.delete(id);
    this.publish(text, mentionUserIds, this.value.sending);
  }

  private publish(text: string, mentionUserIds: readonly string[], sending: boolean): void {
    this.value = Object.freeze({ text, mentionUserIds: Object.freeze([...mentionUserIds]), sending });
    for (const listener of this.listeners) listener();
  }
}

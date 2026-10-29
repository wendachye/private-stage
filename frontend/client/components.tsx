import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Command as CommandPicker, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { AtSign, Ban, Calendar, Check, ChevronDown, ChevronRight, Clock, Crown, Hand, History, Mic, MicOff, MoreHorizontal, Pin, Plus, Search, Send, Settings, Shield, Smile, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import type { AuditEvent, Command, CommandResult, ParticipantView, RoomMode, RoomSnapshot, ScheduledSession } from '../../shared/types';
import { DEFAULT_ROOM_MODE, REACTION_EMOJI } from '../../shared/types';
import { klDate, klInput, klToInstant } from './api';
import { boundedChatInsertion, ChatDraftController, shouldSendChatOnEnter } from './chat-draft-controller';
import { SpeakingModeControl, SPEAKING_MODE_LABELS, speakingModeDescription } from './speaking-mode';

export type CommandHandler = (command: Command) => Promise<CommandResult>;
export type ConfirmHandler = (title: string, detail: string, action: () => Promise<unknown>, actionLabel?: string) => void;
const emojiLabels: Record<string, string> = { '👍': 'Thumbs up', '❤️': 'Heart', '🔥': 'Fire', '👏': 'Applause', '😂': 'Laugh', '🎉': 'Celebrate' };
const scopeOf = (state: RoomSnapshot) => [state.self.userId, state.self.deviceId, state.session?.id ?? 'closed'].join('/');

function usePendingCommand(command: CommandHandler, scope: string) {
  const [pending, setPending] = useState<string | null>(null);
  const mounted = useRef(false), latestScope = useRef(scope), active = useRef<object | undefined>(undefined);
  latestScope.current = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current = undefined; }; }, []);
  useEffect(() => { active.current = undefined; setPending(null); }, [scope]);
  const run = async (value: Command) => {
    if (active.current) return false;
    const attempt = {};
    active.current = attempt;
    setPending(value.type);
    try { await command(value); return mounted.current && latestScope.current === scope && active.current === attempt; }
    catch { return false; }
    finally { if (mounted.current && latestScope.current === scope && active.current === attempt) { active.current = undefined; setPending(null); } }
  };
  return { pending, run };
}

export function Avatar({ name, image, size = '', userId = name }: { name: string; image?: string; size?: string; userId?: string }) {
  const color = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
  return <span className={['avatar', size, 'avatar-' + color].join(' ')} aria-hidden="true"><span>{name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</span>{image && <img src={image} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span>;
}

export function Modal({ title, description, children, onClose, wide = false, dismissible = true, busy = false }: {
  title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; dismissible?: boolean; busy?: boolean;
}) {
  const descriptionId = useId(), canClose = dismissible && !busy;
  return <Dialog open onOpenChange={open => { if (!open && canClose) onClose(); }}>
    <DialogContent className={wide ? 'modal wide' : 'modal'} showCloseButton={false} aria-describedby={description ? descriptionId : undefined} onEscapeKeyDown={event => { if (!canClose) event.preventDefault(); }} onInteractOutside={event => { if (!canClose) event.preventDefault(); }} aria-busy={busy}>
      <div className="modal-header"><DialogTitle>{title}</DialogTitle><DialogClose asChild><Button variant="ghost" size="icon-sm" className="icon-button" disabled={!canClose} aria-label="Close dialog"><X size={18} /></Button></DialogClose></div>
      {description && <DialogDescription id={descriptionId} className="sr-only">{description}</DialogDescription>}{children}
    </DialogContent>
  </Dialog>;
}

export function ParticipantList({ state, command, confirm }: { state: RoomSnapshot; command: CommandHandler; confirm: ConfirmHandler }) {
  const [search, setSearch] = useState('');
  const { pending, run } = usePendingCommand(command, scopeOf(state));
  const microphoneTracks = useTracks([Track.Source.Microphone], { onlySubscribed: false });
  const people = state.participants.filter(person => person.displayName.toLowerCase().includes(search.toLowerCase()));
  return <div className="participant-list">
    <div className="search-field"><Search size={15} /><Input aria-label="Find a participant" placeholder="Find a participant" value={search} onChange={event => setSearch(event.target.value)} /></div>
    {state.handRequests.length > 0 && state.self.isAdmin && <section className="hand-queue"><div className="section-heading"><span><Hand size={14} />Raised hands</span><Badge variant="secondary">{state.handRequests.length}</Badge></div>{state.handRequests.map(hand => <div className="hand-row" key={hand.userId}><span>{hand.displayName}</span><Button variant="ghost" size="icon-sm" className="icon-button" disabled={!!pending} aria-label={'Approve ' + hand.displayName + ' onto stage'} onClick={() => void run({ type: 'member.stage', userId: hand.userId, onStage: true })}><Check size={16} /></Button><Button variant="ghost" size="icon-sm" className="icon-button" disabled={!!pending} aria-label={'Decline ' + hand.displayName + "'s request"} onClick={() => void run({ type: 'hand.decline', userId: hand.userId })}><X size={16} /></Button></div>)}</section>}
    {people.length ? people.map(person => {
      const microphoneOn = microphoneTracks.some(track => person.devices.some(device => device.identity === track.participant.identity) && track.publication && !track.publication.isMuted);
      return <div className="participant-row" key={person.userId}><Avatar name={person.displayName} image={person.avatarUrl} userId={person.userId} /><div className="participant-info"><strong>{person.displayName}{person.userId === state.self.userId && <span className="you-label">you</span>}</strong><small>{person.onStage ? 'On stage' : state.session?.mode === 'open' ? 'In the room' : 'Audience'}{person.devices.length > 1 ? ' · ' + person.devices.length + ' devices' : ''}</small></div>
        {person.isOwner ? <Crown size={14} className="owner-color" aria-label="Owner" /> : person.isAdmin ? <Shield size={14} className="admin-color" aria-label="Admin" /> : null}
        {person.hasHandRaised && <Hand size={15} className="hand-color" aria-label="Hand raised" />}
        {person.microphoneBlocked ? <Ban size={14} className="danger-color" aria-label="Microphone blocked" /> : microphoneOn ? <Mic size={14} className="microphone-on" aria-label="Microphone on" /> : <MicOff size={14} className="muted-color" aria-label="Microphone off" />}
        {state.self.isAdmin && <ParticipantActions person={person} state={state} command={command} confirm={confirm} />}
      </div>;
    }) : <div className="empty-state compact"><p>No participants found.</p></div>}
  </div>;
}

function ParticipantActions({ person, state, command, confirm }: { person: ParticipantView; state: RoomSnapshot; command: CommandHandler; confirm: ConfirmHandler }) {
  const { pending, run } = usePendingCommand(command, scopeOf(state) + '/' + person.userId);
  const openingConfirmation = useRef(false);
  const protectedOwner = person.isOwner && !state.self.isOwner;
  const canRemove = !person.isOwner && (!person.isAdmin || state.self.isOwner);
  const explicitAdmin = state.adminConfiguration?.explicitAdminUserIds.includes(person.userId) ?? false;
  const removal = (action: 'kick' | 'session-block' | 'ban') => {
    openingConfirmation.current = true;
    const title = action === 'kick' ? 'Kick ' + person.displayName + '?' : action === 'session-block' ? 'Block ' + person.displayName + ' for this session?' : 'Ban ' + person.displayName + '?';
    const detail = action === 'kick' ? 'They will be disconnected from all devices. They may rejoin if the room allows it.' : action === 'session-block' ? 'They cannot rejoin this live session from any device.' : 'They cannot enter this or future sessions until an admin restores access.';
    confirm(title, detail, () => command({ type: 'member.remove', userId: person.userId, action }), action === 'kick' ? 'Kick participant' : action === 'session-block' ? 'Block for session' : 'Ban participant');
  };
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="icon-button" disabled={!!pending} aria-label={'Manage ' + person.displayName}><MoreHorizontal size={17} /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="participant-action-menu" onCloseAutoFocus={event => { if (openingConfirmation.current) { event.preventDefault(); openingConfirmation.current = false; } }}>
      <DropdownMenuLabel>{person.displayName}</DropdownMenuLabel>
      <DropdownMenuItem disabled={protectedOwner || !!pending} onSelect={() => void run({ type: 'member.stage', userId: person.userId, onStage: !person.onStage })}>{person.onStage ? <UserMinus /> : <UserPlus />}{person.onStage ? 'Move to audience' : 'Invite to stage'}</DropdownMenuItem>
      <DropdownMenuItem disabled={!!pending} onSelect={() => void run({ type: 'member.microphone', userId: person.userId, action: 'mute' })}><MicOff />Mute once</DropdownMenuItem>
      <DropdownMenuItem disabled={!!pending} onSelect={() => void run({ type: 'member.microphone', userId: person.userId, action: person.microphoneBlocked ? 'allow' : 'block' })}>{person.microphoneBlocked ? <Mic /> : <Ban />}{person.microphoneBlocked ? 'Restore microphone' : 'Block microphone'}</DropdownMenuItem>
      {state.shares.some(share => share.userId === person.userId) && <DropdownMenuItem disabled={!!pending} onSelect={() => void run({ type: 'share.stop', userId: person.userId })}><UserMinus />Stop screen share</DropdownMenuItem>}
      {state.self.isOwner && !person.isOwner && <DropdownMenuItem disabled={!!pending} onSelect={() => void run({ type: 'admin.assign', userId: person.userId, admin: !explicitAdmin })}><Shield />{explicitAdmin ? 'Revoke explicit admin grant' : 'Grant explicit admin access'}</DropdownMenuItem>}
      {canRemove && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => removal('kick')}><UserMinus />Kick participant</DropdownMenuItem><DropdownMenuItem variant="destructive" onSelect={() => removal('session-block')}><Ban />Block for this session</DropdownMenuItem><DropdownMenuItem variant="destructive" onSelect={() => removal('ban')}><Ban />Ban until restored</DropdownMenuItem></>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function MessageText({ text, mentions, ownId }: { text: string; mentions: RoomSnapshot['messages'][number]['mentions']; ownId: string }) {
  if (!mentions.length) return <>{text}</>;
  const ordered = [...mentions].sort((a, b) => b.displayName.length - a.displayName.length);
  const word = (character: string | undefined) => !!character && /[\p{L}\p{N}_]/u.test(character);
  const parts: ReactNode[] = [];
  let cursor = 0, at = text.indexOf('@');
  while (at >= 0) {
    const before = Array.from(text.slice(0, at)).at(-1);
    const match = !word(before) && ordered.find(person => text.startsWith('@' + person.displayName, at)
      && !word(Array.from(text.slice(at + person.displayName.length + 1))[0]));
    if (match) {
      const end = at + match.displayName.length + 1;
      if (cursor < at) parts.push(text.slice(cursor, at));
      const own = mentions.some(person => person.displayName === match.displayName && person.userId === ownId);
      parts.push(<mark key={'mention-' + at} className={own ? 'mention own' : 'mention'}>{text.slice(at, end)}</mark>);
      cursor = end;
      at = text.indexOf('@', end);
    } else at = text.indexOf('@', at + 1);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function EmojiChoices({ onSelect, purpose = 'React with', canChoose }: { onSelect: (emoji: string) => void; purpose?: string; canChoose?: (emoji: string) => boolean }) {
  return <div className="emoji-grid grid grid-cols-6 gap-1" role="group" aria-label="Choose an emoji">{REACTION_EMOJI.map(emoji => <Button key={emoji} type="button" variant="ghost" size="icon" className="emoji-choice text-xl" disabled={canChoose ? !canChoose(emoji) : false} aria-label={purpose + ' ' + emojiLabels[emoji]} onClick={() => onSelect(emoji)}>{emoji}</Button>)}</div>;
}

function MessageActions({ message, state, command }: { message: RoomSnapshot['messages'][number]; state: RoomSnapshot; command: CommandHandler }) {
  const [reactionOpen, setReactionOpen] = useState(false);
  const switchingToReaction = useRef(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { pending, run } = usePendingCommand(command, scopeOf(state) + '/' + message.id);
  const pinned = state.pins.some(pin => pin.messageId === message.id);
  return <div className="message-menu"><Popover open={reactionOpen} onOpenChange={setReactionOpen}>
    <DropdownMenu><PopoverAnchor asChild><DropdownMenuTrigger asChild><Button ref={menuButton} variant="ghost" size="icon-sm" className="icon-button" disabled={!!pending} aria-label={'Message actions for ' + message.displayName}><MoreHorizontal size={15} /></Button></DropdownMenuTrigger></PopoverAnchor>
      <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (switchingToReaction.current) { event.preventDefault(); switchingToReaction.current = false; setReactionOpen(true); } }}>
        <DropdownMenuItem onSelect={() => { switchingToReaction.current = true; }}><Smile />React</DropdownMenuItem>
        {state.self.isAdmin && <><DropdownMenuItem onSelect={() => void run({ type: 'chat.pin', messageId: message.id, pinned: !pinned })}><Pin />{pinned ? 'Unpin message' : 'Pin message'}</DropdownMenuItem><DropdownMenuItem variant="destructive" onSelect={() => void run({ type: 'chat.remove', messageId: message.id })}><Trash2 />Remove message</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
    <PopoverContent align="end" className="emoji-popover w-auto p-2" aria-label="React to message" onCloseAutoFocus={event => { event.preventDefault(); menuButton.current?.focus(); }}><EmojiChoices onSelect={emoji => { setReactionOpen(false); void run({ type: 'chat.react', messageId: message.id, emoji, clientId: crypto.randomUUID() }); }} /></PopoverContent>
  </Popover></div>;
}

export function ChatPanel({ state, command, enabled, draft: suppliedDraft }: { state: RoomSnapshot; command: CommandHandler; enabled: boolean; draft?: ChatDraftController }) {
  const scope = scopeOf(state);
  const [localDraft] = useState(() => new ChatDraftController(scope));
  return <ChatSession key={scope} scope={scope} state={state} command={command} enabled={enabled} draft={suppliedDraft ?? localDraft} />;
}

function ChatSession({ scope, state, command, enabled, draft }: { scope: string; state: RoomSnapshot; command: CommandHandler; enabled: boolean; draft: ChatDraftController }) {
  const { text, sending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [emojiOpen, setEmojiOpen] = useState(false), [mentionOpen, setMentionOpen] = useState(false), [mentionSearch, setMentionSearch] = useState('');
  const end = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), mentionInput = useRef<HTMLInputElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null), emojiContent = useRef<HTMLDivElement>(null), mentionContent = useRef<HTMLDivElement>(null);
  const pickerOpen = useRef(false); pickerOpen.current = emojiOpen || mentionOpen;
  const mentionRange = useRef({ start: 0, end: 0 }), caretAfterMention = useRef<number | undefined>(undefined);
  const mounted = useRef(false), count = useRef(state.messages.length), inputId = useId();
  useEffect(() => { mounted.current = true; draft.reset(scope); return () => { mounted.current = false; }; }, [draft, scope]);
  useEffect(() => { if (state.messages.length !== count.current) end.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' }); count.current = state.messages.length; }, [state.messages.length]);
  useEffect(() => { if (!enabled) { setEmojiOpen(false); setMentionOpen(false); } }, [enabled]);
  const focusDraft = (caret?: number) => {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      const stillInComposer = !focused || focused === document.body || focused === input.current || focused === sendButton.current
        || emojiContent.current?.contains(focused) || mentionContent.current?.contains(focused);
      if (mounted.current && !pickerOpen.current && stillInComposer) {
        input.current?.focus();
        if (caret !== undefined) input.current?.setSelectionRange(caret, caret);
      }
    });
  };
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!enabled) return;
    const attempt = draft.beginSend(state.participants);
    if (!attempt) return;
    try { await command(attempt.payload); draft.succeed(attempt); } catch { draft.fail(attempt); }
    finally {
      const focused = document.activeElement;
      if (mounted.current && (focused === document.body || focused === input.current || focused === sendButton.current)) focusDraft();
    }
  };
  const openMentions = (start: number, end: number) => { mentionRange.current = { start, end }; caretAfterMention.current = undefined; setMentionSearch(''); setEmojiOpen(false); setMentionOpen(true); };
  const mentionInsertion = (person: ParticipantView) => {
    const current = draft.getSnapshot().text, { start, end } = mentionRange.current, prefix = current.slice(0, start);
    const label = (prefix && !/\s$/.test(prefix) ? ' ' : '') + '@' + person.displayName + ' ';
    return boundedChatInsertion(current, label, start, end, state.policy.maxMessageLength);
  };
  const addMention = (person: ParticipantView) => {
    const insertion = mentionInsertion(person);
    if (!insertion) return;
    draft.mention(person, insertion.text);
    caretAfterMention.current = insertion.caret;
    setMentionOpen(false);
  };
  const emojiInsertion = (emoji: string) => {
    const current = draft.getSnapshot().text, start = input.current?.selectionStart ?? current.length, finish = input.current?.selectionEnd ?? start;
    return boundedChatInsertion(current, emoji, start, finish, state.policy.maxMessageLength);
  };
  const pinned = state.pins.map(pin => ({ ...pin, message: state.messages.find(message => message.id === pin.messageId) })).filter(pin => pin.message);
  return <>
    {pinned.length > 0 && <div className="pinned-area"><div className="pinned-heading"><Pin size={13} />Pinned messages<Badge variant="secondary">{pinned.length}/{state.policy.maxPins}</Badge></div>{pinned.map(pin => <Button variant="ghost" key={pin.messageId} className="pinned-message" onClick={() => document.getElementById('message-' + pin.messageId)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' })}><strong>{pin.message!.displayName}</strong><span>{pin.message!.text}</span><small>Pinned by {pin.pinnedByName}</small></Button>)}</div>}
    <div className="chat-messages" aria-live="polite" aria-relevant="additions text" role="log" aria-label="Room chat">
      {!enabled ? <div className="empty-state compact"><p>Join the room to chat.</p></div> : !state.messages.length ? <div className="chat-welcome"><p>No messages yet.</p></div> : state.messages.map(message => <article className={message.mentions.some(mention => mention.userId === state.self.userId) ? 'chat-message mentioned' : 'chat-message'} id={'message-' + message.id} key={message.id}>
        <Avatar name={message.displayName} image={message.avatarUrl} size="small" userId={message.userId} /><div className="message-content"><div className="message-meta"><strong>{message.displayName}</strong><time dateTime={message.createdAt}>{klDate(message.createdAt, { day: undefined, month: undefined, hour: '2-digit', minute: '2-digit' })}</time>{state.pins.some(pin => pin.messageId === message.id) && <Pin size={11} aria-label="Pinned" />}</div><p className="message-body"><MessageText text={message.text} mentions={message.mentions} ownId={state.self.userId} /></p>
          <div className="message-reactions">{Object.entries(message.reactions).filter(([, users]) => users.length).map(([emoji, users]) => <Button variant={users.includes(state.self.userId) ? 'secondary' : 'outline'} size="xs" key={emoji} aria-label={emojiLabels[emoji] + ', ' + users.length + ' reactions'} aria-pressed={users.includes(state.self.userId)} className="reaction-button" onClick={() => void command({ type: 'chat.react', messageId: message.id, emoji, clientId: crypto.randomUUID() }).catch(() => undefined)}>{emoji}<span>{users.length}</span></Button>)}</div>
        </div><MessageActions message={message} state={state} command={command} />
      </article>)}<div ref={end} />
    </div>
    <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
      <PopoverAnchor asChild><form className="chat-composer" onSubmit={event => void send(event)}>
        <Label className="sr-only" htmlFor={inputId}>Message the room</Label>
        <Textarea ref={input} id={inputId} placeholder={enabled ? 'Message the room…' : 'Join the room to chat'} maxLength={state.policy.maxMessageLength} disabled={!enabled} value={text} rows={2} onChange={event => { const next = event.target.value, caret = event.target.selectionStart; draft.setText(next); if (next[caret - 1] === '@' && (caret === 1 || /\s/.test(next[caret - 2])) && !(event.nativeEvent as InputEvent).isComposing) openMentions(caret - 1, caret); }} onKeyDown={event => { if (shouldSendChatOnEnter(event)) { event.preventDefault(); void send(); } }} />
        <div className="composer-actions"><div>
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}><PopoverTrigger asChild><Button variant="ghost" type="button" size="icon-sm" className="icon-button" aria-label="Add an emoji" disabled={!enabled}><Smile size={17} /></Button></PopoverTrigger><PopoverContent ref={emojiContent} align="start" side="top" className="emoji-popover w-auto p-2" aria-label="Add an emoji" onCloseAutoFocus={event => { event.preventDefault(); focusDraft(); }}><EmojiChoices purpose="Insert" canChoose={emoji => !!emojiInsertion(emoji)} onSelect={emoji => { const insertion = emojiInsertion(emoji); if (!insertion) return; draft.setText(insertion.text); setEmojiOpen(false); focusDraft(insertion.caret); }} /></PopoverContent></Popover>
          <Button variant="ghost" type="button" size="icon-sm" className="icon-button" aria-label="Mention a participant" disabled={!enabled} onClick={() => openMentions(input.current?.selectionStart ?? text.length, input.current?.selectionEnd ?? text.length)}><AtSign size={17} /></Button>
        </div><small>{text.length > state.policy.maxMessageLength * .8 ? text.length + '/' + state.policy.maxMessageLength : 'Enter to send · Shift+Enter for a new line'}</small><Tooltip><TooltipTrigger asChild><Button ref={sendButton} size="icon-sm" className="send-button" type="submit" disabled={!enabled || !text.trim() || sending} aria-label="Send message"><Send size={16} /></Button></TooltipTrigger><TooltipContent>Send message</TooltipContent></Tooltip></div>
      </form></PopoverAnchor>
      <PopoverContent ref={mentionContent} side="top" align="start" className="mention-popover w-72 p-0" aria-label="Mention a participant" onOpenAutoFocus={event => { event.preventDefault(); mentionInput.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); focusDraft(caretAfterMention.current); }}>
        <CommandPicker><CommandInput ref={mentionInput} value={mentionSearch} onValueChange={setMentionSearch} placeholder="Find a participant…" aria-label="Search participants to mention" /><CommandList><CommandEmpty>No participants found.</CommandEmpty><CommandGroup>{state.participants.map(person => <CommandItem key={person.userId} value={person.userId} keywords={[person.displayName]} disabled={!mentionInsertion(person)} onSelect={() => addMention(person)}><Avatar name={person.displayName} image={person.avatarUrl} size="small" userId={person.userId} /><span>{person.displayName}</span></CommandItem>)}</CommandGroup></CommandList></CommandPicker>
      </PopoverContent>
    </Popover>
    <div className="chat-retention-note"><Shield size={10} />Chat clears when this session ends.</div>
  </>;
}

export function SchedulePanel({ state, command, onEdit, compact = false }: { state: RoomSnapshot; command: CommandHandler; onEdit: (schedule?: ScheduledSession) => void; compact?: boolean }) {
  const [pastOpen, setPastOpen] = useState(false);
  const { pending, run } = usePendingCommand(command, scopeOf(state));
  const schedules = state.schedules.filter(schedule => schedule.status === 'scheduled'), past = state.schedules.filter(schedule => schedule.status !== 'scheduled');
  const Heading = compact ? 'h2' : 'h1';
  return <section className={compact ? 'upcoming-section' : 'schedule-section'}>
    <div className="section-heading"><Heading>{compact ? 'Upcoming sessions' : 'Scheduled sessions'}</Heading>{!compact && state.self.isAdmin && <Button size="sm" disabled={!!pending} onClick={() => onEdit()}><Plus size={14} />Schedule session</Button>}</div>
    {!compact && <p className="section-description">Kuala Lumpur · UTC+08:00. An admin opens the session, then goes live when ready.</p>}
    <div className="schedule-grid">{schedules.length ? schedules.map(schedule => <Card key={schedule.id} className="schedule-card">
      <CardHeader><div className="schedule-date"><Calendar size={16} /><span>{klDate(schedule.startsAt, { hour: undefined, minute: undefined, day: 'numeric', month: 'short' })}</span></div><h3>{schedule.title}</h3>{schedule.description && <CardDescription>{schedule.description}</CardDescription>}</CardHeader>
      <CardContent><div className="schedule-time"><Clock size={14} />{klDate(schedule.startsAt, { day: undefined, month: undefined })} – {klDate(schedule.endsAt, { day: undefined, month: undefined })}</div><div className="schedule-time"><Mic size={14} /><span>Who can speak: {SPEAKING_MODE_LABELS[schedule.mode ?? DEFAULT_ROOM_MODE]}</span></div></CardContent>
      <CardFooter className="schedule-card-footer"><Badge variant="secondary">Scheduled</Badge>{state.self.isAdmin && <div><Button variant="ghost" size="sm" disabled={!!pending} onClick={() => onEdit(schedule)}>Edit</Button><Button size="sm" disabled={!!state.session || !!pending} onClick={() => void run({ type: 'session.open', scheduleId: schedule.id })}>{pending === 'session.open' ? 'Opening…' : 'Open session'}<ChevronRight size={14} /></Button></div>}</CardFooter>
    </Card>) : <div className="empty-state schedule-empty"><p>No scheduled sessions.</p></div>}</div>
    {!compact && past.length > 0 && <Collapsible open={pastOpen} onOpenChange={setPastOpen} className="past-schedules"><CollapsibleTrigger asChild><Button variant="ghost" size="sm" aria-label="Past and cancelled sessions"><ChevronDown size={14} />Past and cancelled sessions</Button></CollapsibleTrigger><CollapsibleContent>{past.map(schedule => <div className="stat-line" key={schedule.id}><span>{schedule.title}<small>{klDate(schedule.startsAt)}</small></span><Badge variant="outline">{schedule.status === 'cancelled' ? 'Cancelled' : 'Completed'}</Badge></div>)}</CollapsibleContent></Collapsible>}
  </section>;
}

export function ScheduleEditor({ schedule, command, onClose }: { schedule?: ScheduledSession; command: CommandHandler; onClose: () => void }) {
  const [title, setTitle] = useState(schedule?.title ?? ''), [description, setDescription] = useState(schedule?.description ?? '');
  const [mode, setMode] = useState<RoomMode>(schedule?.mode ?? DEFAULT_ROOM_MODE);
  const [start, setStart] = useState(klInput(schedule?.startsAt ?? new Date(Date.now() + 3600000).toISOString()));
  const [end, setEnd] = useState(klInput(schedule?.endsAt ?? new Date(Date.now() + 7200000).toISOString()));
  const [error, setError] = useState(''), [busy, setBusy] = useState<'save' | 'cancel' | null>(null);
  const active = useRef(false), mounted = useRef(false);
  const titleId = useId(), descriptionId = useId(), startId = useId(), endId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const perform = async (action: 'save' | 'cancel') => {
    if (active.current) return;
    active.current = true; setBusy(action); setError('');
    try {
      if (action === 'cancel' && schedule) await command({ type: 'schedule.cancel', id: schedule.id });
      else await command({ type: 'schedule.save', ...(schedule ? { id: schedule.id } : {}), title, description, startsAt: klToInstant(start), endsAt: klToInstant(end), mode });
      if (mounted.current) onClose();
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'The schedule could not be saved.'); }
    finally { active.current = false; if (mounted.current) setBusy(null); }
  };
  return <Modal title={schedule ? 'Edit session' : 'Schedule session'} description="Set the session details in Kuala Lumpur time, then save the schedule." onClose={onClose} busy={!!busy}><form onSubmit={event => { event.preventDefault(); void perform('save'); }}>
    <div className="modal-body"><div className="field"><Label htmlFor={titleId}>Title</Label><Input id={titleId} value={title} disabled={!!busy} required maxLength={100} placeholder="Session title" onChange={event => setTitle(event.target.value)} autoFocus /></div><div className="field"><Label htmlFor={descriptionId}>Description <span className="optional">optional</span></Label><Textarea id={descriptionId} value={description} disabled={!!busy} maxLength={1000} rows={3} onChange={event => setDescription(event.target.value)} placeholder="Add a short description" /></div><div className="form-grid"><div className="field"><Label htmlFor={startId}>Starts</Label><Input id={startId} type="datetime-local" value={start} disabled={!!busy} required onChange={event => setStart(event.target.value)} /></div><div className="field"><Label htmlFor={endId}>Expected end</Label><Input id={endId} type="datetime-local" value={end} disabled={!!busy} required onChange={event => setEnd(event.target.value)} /></div></div><p className="form-hint">KL time (UTC+08:00). Scheduling does not open the room.</p><SpeakingModeControl value={mode} onChange={setMode} disabled={!!busy} /><p className="form-hint">{speakingModeDescription(mode)} Applies in Waiting and Live. Microphones start off.</p>{error && <div className="notice error" role="alert">{error}</div>}</div>
    <div className="modal-footer">{schedule && <Button variant="destructive" type="button" disabled={!!busy} onClick={() => void perform('cancel')}><Trash2 size={14} />{busy === 'cancel' ? 'Cancelling…' : 'Cancel session'}</Button>}<Button type="submit" disabled={!!busy || !title.trim()}>{busy === 'save' ? 'Saving…' : 'Save schedule'}</Button></div>
  </form></Modal>;
}

export function AdminPanel({ state, command }: { state: RoomSnapshot; command: CommandHandler }) {
  const [roleIds, setRoleIds] = useState(state.adminConfiguration?.adminRoleIds.join(', ') ?? ''), [userId, setUserId] = useState('');
  const { pending, run } = usePendingCommand(command, scopeOf(state));
  const roleIdsId = useId(), userIdId = useId(), canonicalRoles = state.adminConfiguration?.adminRoleIds.join(', ') ?? '';
  useEffect(() => { setRoleIds(canonicalRoles); }, [state.self.userId, state.self.deviceId, canonicalRoles]);
  const restrictions = new Map<string, { userId: string; displayName: string; banned: boolean; sessionBlocked: boolean }>();
  for (const ban of state.bans ?? []) restrictions.set(ban.userId, { ...ban, banned: true, sessionBlocked: false });
  for (const block of state.sessionBlocks ?? []) restrictions.set(block.userId, { ...block, banned: restrictions.get(block.userId)?.banned ?? false, sessionBlocked: true });
  const exceptId = state.session?.muteExceptUserId, exceptName = exceptId === state.self.userId ? 'you' : state.participants.find(person => person.userId === exceptId)?.displayName ?? 'the selected admin';
  const groupRestricted = !!state.session?.audienceMuted || !!exceptId;
  return <div className="admin-panel"><div className="section-heading"><h1>Room management</h1></div><div className="management-grid">
    <Card className="management-card"><CardHeader><h2>Speaking permissions</h2><CardDescription>Members choose when to turn on their microphones.</CardDescription></CardHeader><CardContent>
      <div className="policy-status" aria-label="Current group microphone restrictions">{!state.session ? <Badge variant="outline">Session closed</Badge> : <><Badge variant="outline">{SPEAKING_MODE_LABELS[state.session.mode]}</Badge>{state.session.audienceMuted && <Badge variant="secondary">Audience muted</Badge>}{exceptId && <Badge variant="secondary">Everyone muted except {exceptName}</Badge>}{!groupRestricted && <Badge variant="outline">No group restrictions</Badge>}</>}</div>
      {state.session && <div className="waiting-voice-setting"><SpeakingModeControl value={state.session.mode} disabled={!!pending} onChange={mode => void run({ type: 'room.mode', mode })} /><p className="form-hint">{speakingModeDescription(state.session.mode)} Going live keeps this choice.</p></div>}
      <div className="stack-buttons"><Button variant="outline" disabled={!state.session || !!pending || state.session.audienceMuted} aria-pressed={!!state.session?.audienceMuted} onClick={() => void run({ type: 'group.microphone', action: 'audience' })}><MicOff size={16} />Mute audience</Button><Button variant="outline" disabled={!state.session || !!pending || exceptId === state.self.userId} aria-pressed={exceptId === state.self.userId} onClick={() => void run({ type: 'group.microphone', action: 'except-me' })}><MicOff size={16} />Mute everyone except me</Button><Button variant="outline" disabled={!state.session || !!pending || !groupRestricted} onClick={() => void run({ type: 'group.microphone', action: 'allow' })}><Mic size={16} />Clear group restrictions</Button></div><p className="form-hint">Speaking mode and individual microphone blocks still apply.</p>
    </CardContent></Card>
    <Card className="management-card"><CardHeader><h2>Restricted members</h2><CardDescription>Session blocks end with the session. Bans remain until restored.</CardDescription></CardHeader><CardContent>{restrictions.size ? [...restrictions.values()].map(member => <div className="stat-line" key={member.userId}><span>{member.displayName}<small>{[member.banned && 'Banned', member.sessionBlocked && 'Blocked this session'].filter(Boolean).join(' · ')}</small></span><Button variant="outline" size="sm" disabled={!!pending} aria-label={'Restore access for ' + member.displayName} onClick={() => void run({ type: 'member.restore', userId: member.userId })}>Restore access</Button></div>) : <p className="empty-state compact">No restricted members.</p>}</CardContent></Card>
    {state.self.isOwner && <Card className="management-card owner-card"><CardHeader><h2><Crown size={16} />Owner settings</h2><CardDescription>Choose who can manage this room.</CardDescription></CardHeader><CardContent>
      <form onSubmit={event => { event.preventDefault(); void run({ type: 'admin.roles', roleIds: roleIds.split(/[\s,]+/).filter(Boolean) }); }}><div className="field"><Label htmlFor={roleIdsId}>Discord admin role IDs</Label><Textarea id={roleIdsId} rows={2} value={roleIds} disabled={!!pending} onChange={event => setRoleIds(event.target.value)} placeholder="Role IDs, separated by commas" /></div><Button variant="outline" type="submit" disabled={!!pending || roleIds === canonicalRoles}>{pending === 'admin.roles' ? 'Saving…' : 'Save role mapping'}</Button></form>
      <Separator className="my-5" />
      <form onSubmit={event => { event.preventDefault(); const id = userId.trim(); if (id) void run({ type: 'admin.assign', userId: id, admin: true }).then(success => { if (success) setUserId(''); }); }}><div className="field"><Label htmlFor={userIdId}>Grant a member admin access</Label><div className="inline-form"><Input id={userIdId} value={userId} disabled={!!pending} onChange={event => setUserId(event.target.value)} placeholder="Discord user ID" inputMode="numeric" autoComplete="off" /><Button type="submit" disabled={!!pending || !userId.trim()}>{pending === 'admin.assign' ? 'Saving…' : 'Grant'}</Button></div></div></form>
      {state.adminConfiguration?.explicitAdminUserIds.map(id => <div className="stat-line" key={id}><code>{id}</code><Button variant="ghost" size="sm" disabled={!!pending} aria-label={'Revoke admin grant for ' + id} onClick={() => void run({ type: 'admin.assign', userId: id, admin: false })}>Revoke grant</Button></div>)}
    </CardContent></Card>}
    <Card className="management-card"><CardHeader><h2><Settings size={16} />Room limits</h2></CardHeader><CardContent><div className="stat-line"><span>Screen shares</span><strong>{state.policy.maxScreenShares}</strong></div><div className="stat-line"><span>Pinned messages</span><strong>{state.policy.maxPins}</strong></div><div className="stat-line"><span>Reconnect grace</span><strong>{state.policy.reconnectGraceSeconds}s</strong></div><div className="stat-line"><span>Action history</span><strong>{state.policy.auditRetentionDays} days</strong></div></CardContent></Card>
  </div></div>;
}

const auditLabels: Record<string, string> = {
  'session.open': 'Open session', 'session.start': 'Go live', 'room.waiting-audio': 'Change waiting-room audio', 'session.end': 'End session', 'room.join': 'Join room', 'room.leave': 'Leave room', 'room.lock': 'Change room lock', 'room.mode': 'Change speaking mode',
  'schedule.save': 'Save schedule', 'schedule.cancel': 'Cancel schedule', 'member.stage': 'Change stage access', 'hand.set': 'Change hand request', 'hand.decline': 'Decline hand request',
  'member.microphone': 'Change microphone permission', 'group.microphone': 'Change group microphone policy', 'mic.acquire': 'Enable microphone', 'mic.release': 'Release microphone',
  'share.reserve': 'Request screen share', 'share.confirm': 'Start screen share', 'share.release': 'Stop screen share', 'share.stop': 'Stop member screen share', 'spotlight.set': 'Change spotlight',
  'chat.send': 'Send message', 'chat.react': 'React to message', 'chat.pin': 'Change message pin', 'chat.remove': 'Remove message', 'reaction.send': 'Send reaction',
  'admin.roles': 'Change admin roles', 'admin.assign': 'Change admin grant', 'member.remove': 'Restrict member access', 'member.restore': 'Restore member access', 'startup.close': 'Close previous session', 'membership.invalidate': 'End member access',
};

function auditTarget(event: AuditEvent, state: RoomSnapshot): string | undefined {
  if (!event.targetId) return;
  if (event.action.startsWith('chat.')) return 'Message';
  if (event.action.startsWith('schedule.')) return state.schedules.find(schedule => schedule.id === event.targetId)?.title ?? 'Scheduled session';
  if (event.action.startsWith('share.') || event.action === 'spotlight.set') return state.shares.find(share => share.reservationId === event.targetId || share.userId === event.targetId)?.displayName ?? 'Screen share';
  return state.participants.find(person => person.userId === event.targetId)?.displayName ?? state.bans?.find(person => person.userId === event.targetId)?.displayName ?? state.sessionBlocks?.find(person => person.userId === event.targetId)?.displayName ?? (event.targetId === state.self.userId ? state.self.displayName : 'Member');
}

export function AuditPanel({ state }: { state: RoomSnapshot }) {
  return <section className="audit-panel"><div className="section-heading"><h1>Action history</h1></div><p className="section-description">Room and moderation changes · KL time</p>
    <div className="audit-list">{state.audit?.length ? [...state.audit].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map(event => <Collapsible key={event.id} asChild><article className="audit-row">
      <span className={'audit-dot ' + event.outcome} /><div><strong>{auditLabels[event.action] ?? 'Room activity'}</strong><p>{event.actorName}{auditTarget(event, state) ? ' → ' + auditTarget(event, state) : ''}</p></div><div className="audit-meta"><time dateTime={event.timestamp}>{klDate(event.timestamp)}</time><Badge variant={event.outcome === 'success' ? 'secondary' : 'outline'}>{event.outcome === 'success' ? 'Completed' : event.outcome === 'denied' ? 'Denied' : 'Failed'}</Badge></div>
      <CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm" className="audit-details-trigger" aria-label={'View record details for ' + (auditLabels[event.action] ?? 'room activity')}><ChevronDown size={14} /></Button></CollapsibleTrigger>
      <CollapsibleContent className="audit-details col-span-full"><dl><div><dt>Action</dt><dd>{event.action}</dd></div><div><dt>Record ID</dt><dd><code>{event.id}</code></dd></div><div><dt>Actor ID</dt><dd><code>{event.actorId}</code></dd></div>{event.targetId && <div><dt>Target ID</dt><dd><code>{event.targetId}</code></dd></div>}{event.sessionId && <div><dt>Session ID</dt><dd><code>{event.sessionId}</code></dd></div>}{event.detail && <div><dt>Detail</dt><dd><code>{event.detail}</code></dd></div>}</dl></CollapsibleContent>
    </article></Collapsible>) : <div className="empty-state"><History size={24} /><p>No admin activity yet.</p></div>}</div>
  </section>;
}

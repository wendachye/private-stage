import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';
import { AlertCircle, ArrowRight, Calendar, ChevronDown, Crown, Hand, Headphones, History, Lock, LogOut, MessageCircle, Mic, MicOff, Monitor, MonitorUp, Plus, Radio, RefreshCw, Settings, Shield, Smile, Square, Unlock, Users, X } from 'lucide-react';
import type { ParticipantView, RoomMode, RoomSnapshot, ScheduledSession } from '../../shared/types';
import { DEFAULT_ROOM_MODE, REACTION_EMOJI } from '../../shared/types';
import { apiUrl, logout, previewLogin } from './api';
import { AdminPanel, AuditPanel, Avatar, ChatPanel, Modal, ParticipantList, ScheduleEditor, SchedulePanel } from './components';
import { AudioNotice, MediaProvider, ScreenWorkspace, useStageMedia } from './media';
import { useRoomModel } from './useRoomModel';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DialogScopeGate, type DialogTicket } from './dialog-scope';
import { ChatDraftController } from './chat-draft-controller';
import { participantMediaState } from './participant-media-state';
import { OpenedSessionJoinGate } from './opened-session-join';
import { SpeakingModeControl, SPEAKING_MODE_LABELS as modeLabels, speakingModeDescription } from './speaking-mode';
import { MicrophoneTestController, createMicrophoneMeter, type MicrophoneTestPhase } from './microphone-test-controller';

const emojiLabels: Record<string, string> = { '👍': 'Thumbs up', '❤️': 'Heart', '🔥': 'Fire', '👏': 'Applause', '😂': 'Laugh', '🎉': 'Celebrate' };
type View = 'stage' | 'schedule' | 'manage' | 'history';
type ConfirmAction = { ticket: DialogTicket; title: string; detail: string; actionLabel: string; action: () => Promise<unknown> };

function Brand() {
  return <div className="brand"><span className="brand-mark"><Radio size={20} /></span><span className="brand-name">Private Stage</span></div>;
}

function useRetrySeconds(retryAt?: string | number) {
  const deadline = typeof retryAt === 'string' ? Date.parse(retryAt) : retryAt ?? 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    const timer = setInterval(() => { const next = Date.now(); setNow(next); if (next >= deadline) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}
const retryLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export default function App() {
  const model = useRoomModel();
  const verificationRetrySeconds = useRetrySeconds(model.verificationRetryAt);
  const { boot, state, command, error, setError } = model;
  const [view, setView] = useState<View>('stage');
  const [panel, setPanel] = useState<'chat' | 'people'>('chat');
  const [mobilePanel, setMobilePanel] = useState<'stage' | 'chat' | 'people'>('stage');
  const [settings, setSettings] = useState<DialogTicket | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<{ ticket: DialogTicket; schedule?: ScheduledSession } | null>(null);
  const [opening, setOpening] = useState<DialogTicket | null>(null);
  const [confirming, setConfirming] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [reactions, setReactions] = useState(false);
  const [personaBusy, setPersonaBusy] = useState(false);
  const [roomBusy, setRoomBusy] = useState<'start' | 'mode' | null>(null);
  const roomInFlight = useRef<string | null>(null);
  const [openingJoins] = useState(() => new OpenedSessionJoinGate());
  const [openingJoinRevision, setOpeningJoinRevision] = useState(0);
  const [dialogScope] = useState(() => new DialogScopeGate());
  const confirmInFlight = useRef<DialogTicket | null>(null);
  const cancelConfirm = useRef<HTMLButtonElement>(null);
  const scopeKey = JSON.stringify([boot?.auth.user?.userId ?? state?.self.userId, boot?.deviceId ?? state?.self.deviceId, state?.session?.id ?? 'closed', state?.self.isOwner ? 'owner' : state?.self.isAdmin ? 'admin' : 'member']);
  const accountScope = JSON.stringify([boot?.auth.status, boot?.auth.user?.userId ?? state?.self.userId, boot?.deviceId ?? state?.self.deviceId, state?.self.isOwner ? 'owner' : state?.self.isAdmin ? 'admin' : 'member']);
  openingJoins.setScope(accountScope);
  const chatScope = [boot?.auth.user?.userId ?? state?.self.userId ?? 'anonymous', boot?.deviceId ?? state?.self.deviceId ?? 'unknown', state?.session?.id ?? 'closed'].join('/');
  const chatDraft = useMemo(() => new ChatDraftController(chatScope), [chatScope]);
  useEffect(() => { chatDraft.reset(chatScope); return () => chatDraft.reset(null); }, [chatDraft, chatScope]);
  dialogScope.setScope(scopeKey);
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const clearDialogs = useCallback(() => {
    setSettings(null); setEditingSchedule(null); setOpening(null); setConfirming(null);
    setConfirmBusy(false); setConfirmError(''); confirmInFlight.current = null;
  }, []);
  useEffect(() => { clearDialogs(); setView('stage'); setPanel('chat'); setMobilePanel('stage'); setReactions(false); setPersonaBusy(false); setRoomBusy(null); roomInFlight.current = null; }, [scopeKey, clearDialogs]);
  const closeDialog = useCallback((ticket: DialogTicket) => { if (dialogScope.close(ticket)) clearDialogs(); }, [dialogScope, clearDialogs]);
  const openSettings = useCallback(() => { clearDialogs(); setSettings(dialogScope.open()); }, [dialogScope, clearDialogs]);
  const openSchedule = useCallback((schedule?: ScheduledSession) => { clearDialogs(); setEditingSchedule({ ticket: dialogScope.open(), schedule }); }, [dialogScope, clearDialogs]);
  const openSession = useCallback(() => { clearDialogs(); setOpening(dialogScope.open()); }, [dialogScope, clearDialogs]);
  const confirm = useCallback((title: string, detail: string, action: () => Promise<unknown>, actionLabel = 'Continue') => {
    clearDialogs(); setConfirming({ ticket: dialogScope.open(), title, detail, action, actionLabel });
  }, [dialogScope, clearDialogs]);
  const notify = useCallback((message: string) => setError(message), [setError]);
  const media = useStageMedia(state, command, boot?.configuration.mediaConfigured ?? false, notify);
  const scopedCommand = useCallback(async (value: Parameters<typeof command>[0]) => {
    if (scopeRef.current !== scopeKey) return Promise.reject(new Error('The room or your access changed. Open this action again.'));
    const opening = value.type === 'session.open' ? openingJoins.capture() : null;
    const result = await command(value);
    if (opening && openingJoins.queue(opening, result.snapshot)) {
      setOpeningJoinRevision(revision => revision + 1);
    }
    return result;
  }, [command, scopeKey, openingJoins]);
  useEffect(() => {
    const ticket = openingJoins.take(state, media.joining);
    if (ticket) {
      setView('stage'); setPanel('chat'); setMobilePanel('stage');
      void media.join(ticket);
    }
  }, [state, openingJoinRevision, openingJoins, media.join, media.joining]);
  const doLogout = async () => { openingJoins.clear(); await media.room.disconnect(); await logout(); await model.initialize(); };

  const roomAction = async (action: 'start' | 'mode', mode?: RoomMode) => {
    if (roomInFlight.current || !state?.session || (action === 'start' && state.session.state !== 'waiting') || (action === 'mode' && !mode)) return;
    const operationScope = scopeKey;
    roomInFlight.current = operationScope; setRoomBusy(action);
    try { await scopedCommand(action === 'start' ? { type: 'session.start' } : { type: 'room.mode', mode: mode! }); }
    catch { /* The shared notice keeps the error and retry guidance visible. */ }
    finally { if (roomInFlight.current === operationScope) { roomInFlight.current = null; setRoomBusy(null); } }
  };

  const performConfirm = async () => {
    const action = confirming;
    if (!action || !dialogScope.current(action.ticket) || confirmInFlight.current === action.ticket) return;
    confirmInFlight.current = action.ticket; setConfirmBusy(true); setConfirmError('');
    try { await action.action(); closeDialog(action.ticket); }
    catch (reason) { if (dialogScope.current(action.ticket)) setConfirmError(reason instanceof Error ? reason.message : 'The action could not be completed. Try again.'); }
    finally { if (confirmInFlight.current === action.ticket) confirmInFlight.current = null; if (dialogScope.current(action.ticket)) setConfirmBusy(false); }
  };

  if (model.loading) return <main className="loading-screen"><Brand /><p>Loading room…</p></main>;
  if (!boot || !state || boot.auth.status !== 'authenticated') return <AuthScreen model={model} />;
  const admin = state.self.isAdmin || state.self.isOwner;
  const admitted = !!state.self.admission;
  const live = !!state.session;
  const waiting = state.session?.state === 'waiting';
  const mediaConnected = media.connection === ConnectionState.Connected;
  const me = state.participants.find(person => person.userId === state.self.userId);
  const onStage = me?.onStage ?? false;
  const stage = state.participants.filter(person => person.onStage);
  const audience = state.participants.filter(person => !person.onStage);
  const nav = (next: View) => { setView(next); setMobilePanel('stage'); setReactions(false); };
  const recentReactions = state.reactions.filter(reaction => Date.now() - new Date(reaction.createdAt).getTime() < 6000);
  const selectPersona = async (persona: string) => {
    openingJoins.clear();
    const startedScope = scopeKey; setPersonaBusy(true);
    try { await media.room.disconnect(); await previewLogin(persona); await model.initialize(); }
    catch (reason) { if (scopeRef.current === startedScope) setError(reason instanceof Error ? reason.message : 'Preview identity could not be changed.'); }
    finally { if (scopeRef.current === startedScope) setPersonaBusy(false); }
  };
  const previewState = !boot.configuration.discordConfigured && boot.localPreview;

  return <TooltipProvider><MediaProvider room={media.room}><div className={`app-shell mobile-view-${mobilePanel}`}>
    {boot.localPreview && <div className="preview-banner"><span>Local preview · fictional identities</span><div className="persona-switch"><Label htmlFor="preview-persona">Preview identity</Label><Select disabled={personaBusy} value={state.self.userId.includes('owner') ? 'owner' : state.self.userId.includes('admin') ? 'admin' : state.self.userId.includes('member3') ? 'member3' : state.self.userId.includes('member2') ? 'member2' : 'member'} onValueChange={value => void selectPersona(value)}><SelectTrigger id="preview-persona" size="sm" aria-label="Local preview identity"><SelectValue /></SelectTrigger><SelectContent>{[['owner', 'Local owner'], ['admin', 'Local admin'], ['member', 'Local member'], ['member2', 'Second member'], ['member3', 'Third member']].map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select></div></div>}
    <header className="app-header"><Brand /><div className="header-center"><span className="community-label"><Shield size={13} />Private community</span></div><div className="header-actions"><span className="connection-status" role="status"><span className={model.connected ? 'connection-dot' : 'offline-dot'} />{!model.online ? 'Live updates offline' : model.connected ? 'Live updates connected' : 'Live updates reconnecting'}</span><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="settings-shortcut" aria-label="Audio and preferences" onClick={openSettings}><Settings size={18} /></Button></TooltipTrigger><TooltipContent>Audio & preferences</TooltipContent></Tooltip><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="profile-summary" aria-label="Your account"><Avatar name={state.self.displayName} image={state.self.avatarUrl} size="small" userId={state.self.userId} /><span>{state.self.displayName}</span><ChevronDown size={13} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>{state.self.isOwner ? 'Community owner' : state.self.isAdmin ? 'App admin' : 'Community member'}</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => openSettings()}><Settings size={14} />Audio & preferences</DropdownMenuItem>{admin && <><DropdownMenuItem onSelect={() => nav('manage')}><Shield size={14} />Room management</DropdownMenuItem><DropdownMenuItem onSelect={() => nav('history')}><History size={14} />Action history</DropdownMenuItem></>}<DropdownMenuItem onSelect={() => void doLogout().catch(reason => setError(reason.message))}><LogOut size={14} />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></header>
    <div className={`app-body ${view === 'stage' && live ? 'with-room-panel' : 'full-width'}`}>
      <nav className="side-nav" aria-label="Main navigation"><div><Button variant={view === 'stage' ? 'secondary' : 'ghost'} className={`nav-item ${view === 'stage' ? 'active' : ''}`} aria-current={view === 'stage' ? 'page' : undefined} title="The stage" aria-label="The stage" onClick={() => nav('stage')}><Radio size={21} /><span>Stage</span>{live && <i />}</Button><Button variant={view === 'schedule' ? 'secondary' : 'ghost'} className={`nav-item ${view === 'schedule' ? 'active' : ''}`} aria-current={view === 'schedule' ? 'page' : undefined} title="Sessions" aria-label="Scheduled sessions" onClick={() => nav('schedule')}><Calendar size={21} /><span>Sessions</span></Button>{admin && <><span className="nav-divider" /><Button variant={view === 'manage' ? 'secondary' : 'ghost'} className={`nav-item ${view === 'manage' ? 'active' : ''}`} aria-current={view === 'manage' ? 'page' : undefined} title="Room management" aria-label="Room management" onClick={() => nav('manage')}><Shield size={21} /><span>Manage</span></Button><Button variant={view === 'history' ? 'secondary' : 'ghost'} className={`nav-item ${view === 'history' ? 'active' : ''}`} aria-current={view === 'history' ? 'page' : undefined} title="Action history" aria-label="Admin action history" onClick={() => nav('history')}><History size={21} /><span>History</span></Button></>}</div><Button variant="ghost" className="nav-item" title="Settings" aria-label="Settings" onClick={() => openSettings()}><Settings size={21} /><span>Settings</span></Button></nav>
      <main className="main-column" id="main-content">
        {error && <div className="notice error dismissible" role="alert"><AlertCircle size={16} /><span>{error}{verificationRetrySeconds > 0 && ` Retry available in ${retryLabel(verificationRetrySeconds)}.`}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></Button></div>}
        {!model.connected && <div className="notice warning connection-notice" role="status"><RefreshCw size={16} /><span>{model.online ? 'Live updates are reconnecting. The room will keep refreshing in the meantime.' : 'You’re offline. Room controls will be available when your connection returns.'}</span><Button variant="ghost" size="sm" disabled={!model.online} onClick={model.reconnect}>Retry connection</Button></div>}
        {state.cleanupPending && <div className="notice warning"><RefreshCw size={16} /><span>The previous media session is being closed. New admissions remain paused until cleanup is complete.</span></div>}
        {admin && state.mediaSyncPending && !state.cleanupPending && <div className="notice warning" role="status"><RefreshCw size={16} /><span>Media permission changes are awaiting confirmation. Some restrictions may still be pending; the server is retrying.</span></div>}
        {view === 'stage' && (live ? <>
          <div className="session-heading"><div><div className="session-meta"><Badge className={waiting ? 'badge waiting' : 'badge live'} variant={waiting ? 'outline' : 'secondary'}>{waiting ? 'Waiting' : 'Live'}</Badge><span className="session-mode-label">{modeLabels[state.session!.mode]}</span>{state.session!.locked && <span className="room-locked"><Lock size={12} />Locked</span>}</div><h1 className="room-title">{state.session!.title}</h1></div><div className="session-heading-actions"><span className="participant-count"><Users size={15} />{state.participants.length}<span>in the room</span></span>{admin && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm">Room options<ChevronDown size={13} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void scopedCommand({ type: 'room.lock', locked: !state.session!.locked }).catch(() => undefined)}>{state.session!.locked ? <Unlock size={14} /> : <Lock size={14} />}{state.session!.locked ? 'Unlock new admissions' : 'Lock new admissions'}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => confirm('End this session?', 'Everyone will be disconnected. Current chat, pins, reactions, hands, and shares will be cleared. Schedules and action history are retained.', () => scopedCommand({ type: 'session.end' }), 'End session')}><Square size={14} />End session</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}</div></div>
          <Card className="waiting-room-panel speaking-mode-panel"><div className="waiting-room-summary"><h2>{waiting ? admin ? 'Your session is open' : 'Waiting for the host' : 'Room conversation'}</h2><p>{waiting ? admin ? 'Members can join and talk using the selected speaking mode. Go live when you’re ready.' : 'You can join the conversation while the host gets ready.' : 'The speaking mode applies to everyone in this room.'}</p></div><div className="waiting-room-controls"><div className="waiting-voice-setting">{admin ? <SpeakingModeControl value={state.session!.mode} disabled={!!roomBusy || verificationRetrySeconds > 0} onChange={mode => void roomAction('mode', mode)} /> : <div className="waiting-voice-status" role="status"><strong>{modeLabels[state.session!.mode]}</strong></div>}<p className="form-hint">{speakingModeDescription(state.session!.mode)} Existing microphone blocks and group restrictions still apply.</p><p className="form-hint">Screen sharing requires stage approval. Anything you unmute or share is available to members here.</p></div>{waiting && admin && <div className="waiting-go-live"><Button disabled={!!roomBusy || verificationRetrySeconds > 0 || !admitted || (boot.configuration.mediaConfigured && !mediaConnected)} onClick={() => void roomAction('start')}><Radio size={15} />{roomBusy === 'start' ? 'Starting…' : 'Go live'}</Button><p className="form-hint">Speaking mode and chat stay the same.</p></div>}</div></Card>
          {!admitted && <div className={`join-banner ${state.session!.locked ? 'locked' : ''}`}><div><Headphones size={21} /><span><strong>{state.self.banned ? 'Your access is restricted' : state.self.sessionBlocked ? 'You’re blocked for this session' : state.session!.locked && !admin ? 'The room is locked' : 'Join the room'}</strong><small>{state.self.banned || state.self.sessionBlocked ? 'Contact a community admin about access.' : state.session!.locked && !admin ? 'Current participants can stay. New admissions are paused.' : 'Your microphone starts off.'}</small></span></div><Button variant="default" disabled={media.joining || state.self.banned || state.self.sessionBlocked || (state.session!.locked && !admin)} onClick={() => void media.join()}>{media.joining ? 'Connecting…' : 'Join room'}<ArrowRight size={15} /></Button></div>}
          {admitted && !mediaConnected && <div className="notice info"><Headphones size={16} /><span>{boot.configuration.mediaConfigured ? media.connection === ConnectionState.Reconnecting ? 'Media is reconnecting. Your room permissions remain in place.' : 'Connect to hear the room and share media.' : 'Room controls and chat are available locally. The LiveKit media server is not connected yet.'}</span>{boot.configuration.mediaConfigured && <Button variant="outline" size="sm" disabled={media.joining} onClick={() => void media.join()}>{media.joining ? 'Connecting…' : 'Connect to room'}</Button>}</div>}
          {mediaConnected && !media.audioEnabled && <AudioNotice onEnable={() => void media.enableAudio()} />}
          <ScreenWorkspace state={state} command={scopedCommand} connected={mediaConnected} canShare={state.self.canShare} sharePending={media.sharePending} onShare={() => void media.toggleShare()} />
          <section className="speaker-section"><div className="section-heading"><span>On stage <span className="subtle-count">{stage.length}</span></span>{admin && admitted && !onStage && <Button variant="ghost" size="sm" onClick={() => void scopedCommand({ type: 'member.stage', userId: state.self.userId, onStage: true }).catch(() => undefined)}><Plus size={13} />Join stage</Button>}<Button variant="ghost" size="sm" onClick={() => { setView('stage'); setPanel('people'); setMobilePanel('people'); }}>View participants <ArrowRight size={12} /></Button></div><div className="speaker-strip">{stage.length ? stage.map(person => <SpeakerCard key={person.userId} person={person} room={media.room} ownId={state.self.userId} />) : <div className="stage-empty"><Mic size={19} /><span>No speakers yet.</span><small>{admin ? 'Join the stage or invite a participant.' : 'An admin can invite speakers to the stage.'}</small></div>}</div></section>
          <section className="audience-section"><div className="audience-label"><Headphones size={13} />{state.session!.mode === 'open' ? 'Members' : 'Audience'} <span>{audience.length}</span></div><div className="avatar-stack">{audience.slice(0, 10).map(person => <span key={person.userId} title={person.displayName}><Avatar name={person.displayName} image={person.avatarUrl} userId={person.userId} size="small" /></span>)}{audience.length > 10 && <span className="extra-audience">+{audience.length - 10}</span>}</div></section>
        </> : <WaitingRoom state={state} onOpen={() => openSession()} onSchedule={openSchedule} command={scopedCommand} />)}
        {view === 'schedule' && <SchedulePanel key={scopeKey} state={state} command={scopedCommand} onEdit={openSchedule} />}
        {view === 'manage' && admin && <AdminPanel key={scopeKey} state={state} command={scopedCommand} />}
        {view === 'history' && admin && <AuditPanel state={state} />}
      </main>
      {live && view === 'stage' && <aside className={`chat-panel panel-${panel}`} aria-label="Conversation and participants"><Tabs value={panel} onValueChange={value => setPanel(value as 'chat' | 'people')} className="room-panel-tabs"><TabsList variant="line" className="panel-tabs"><TabsTrigger value="chat" className={`panel-tab ${panel === 'chat' ? 'active' : ''}`}><MessageCircle size={16} />Room chat</TabsTrigger><TabsTrigger value="people" className={`panel-tab ${panel === 'people' ? 'active' : ''}`}><Users size={16} />People<span>{state.participants.length}</span></TabsTrigger></TabsList><TabsContent value="chat" className="panel-content"><ChatPanel state={state} command={scopedCommand} enabled={admitted} draft={chatDraft} /></TabsContent><TabsContent value="people" className="panel-content"><ParticipantList state={state} command={scopedCommand} confirm={confirm} /></TabsContent></Tabs></aside>}
    </div>
    {live && <footer className="bottom-bar"><div className="bottom-room-info"><Radio size={16} /><div><strong>{onStage ? 'On stage' : admitted ? state.session!.mode === 'open' ? 'In the room' : 'In the audience' : 'Not joined'}</strong><span>{mediaConnected ? 'Media connected' : 'Media disconnected'}</span></div></div><div className="control-group">
      <Button variant={media.microphone ? 'secondary' : 'ghost'} className={`control-button ${media.microphone ? 'active' : ''} ${admitted && !state.self.canSpeak ? 'blocked' : ''}`} disabled={!live || !admitted || !state.self.canSpeak || !mediaConnected || media.microphonePending} onClick={() => void media.toggleMic()} title={!state.self.canSpeak ? 'Microphone is restricted by the current room policy' : 'Use this device’s microphone'}>{media.microphone ? <Mic size={19} /> : <MicOff size={19} />}<span>{media.microphonePending ? 'Updating…' : media.microphone ? 'Mute' : state.self.canSpeak ? 'Unmute' : 'Mic off'}</span></Button>
      <Button variant={media.sharing || media.sharePending ? 'secondary' : 'ghost'} className={`control-button ${media.sharing ? 'active' : ''}`} disabled={!live || !admitted || (!state.self.canShare && !media.sharing) || !mediaConnected} onClick={() => void media.toggleShare()} title={media.sharePending ? 'Cancel this screen-sharing attempt' : typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? state.self.canShare ? 'Share a screen' : 'Only approved stage speakers can share' : 'Screen broadcasting is unavailable in this browser'}><MonitorUp size={19} /><span>{media.sharePending ? 'Cancel share' : media.sharing ? 'Stop share' : 'Share screen'}</span></Button>
      <Button variant={me?.hasHandRaised ? 'secondary' : 'ghost'} className={`control-button ${me?.hasHandRaised ? 'active' : ''}`} disabled={!live || !admitted || onStage} onClick={() => void scopedCommand({ type: 'hand.set', raised: !me?.hasHandRaised }).catch(() => undefined)}><Hand size={19} /><span>{me?.hasHandRaised ? 'Lower hand' : 'Raise hand'}</span></Button>
      <Popover open={reactions} onOpenChange={setReactions}><PopoverTrigger asChild><Button variant={reactions ? 'secondary' : 'ghost'} className="control-button" disabled={!live || !admitted} aria-label="React to the stage"><Smile size={19} /><span>React</span></Button></PopoverTrigger><PopoverContent side="top" align="center" className="reaction-picker" aria-label="Choose a reaction">{REACTION_EMOJI.map(emoji => <Button variant="ghost" size="icon" key={emoji} aria-label={emojiLabels[emoji]} onClick={() => { void scopedCommand({ type: 'reaction.send', emoji, clientId: crypto.randomUUID() }).catch(() => undefined); setReactions(false); }}>{emoji}</Button>)}</PopoverContent></Popover>
      <span className="control-divider" /><Button variant="ghost" className="control-button settings-control" onClick={() => openSettings()}><Settings size={19} /><span>Settings</span></Button>
    </div><div className="bottom-end">{admitted ? <Button variant="outline" className="leave-room-button" aria-label="Leave room" onClick={() => void media.leave()}><LogOut size={15} /><span>Leave room</span></Button> : <Button disabled={media.joining || state.self.banned || state.self.sessionBlocked || (state.session!.locked && !admin)} onClick={() => void media.join()}><Headphones size={15} />{media.joining ? 'Connecting…' : 'Join room'}</Button>}</div></footer>}
    <nav className="mobile-tabs" aria-label="Mobile room panels"><Button variant={view === 'stage' && mobilePanel === 'stage' ? 'secondary' : 'ghost'} className={view === 'stage' && mobilePanel === 'stage' ? 'active' : ''} aria-current={view === 'stage' && mobilePanel === 'stage' ? 'page' : undefined} onClick={() => nav('stage')}><Monitor size={18} /><span>Stage</span></Button>{live && <><Button variant={view === 'stage' && mobilePanel === 'chat' ? 'secondary' : 'ghost'} className={view === 'stage' && mobilePanel === 'chat' ? 'active' : ''} aria-current={view === 'stage' && mobilePanel === 'chat' ? 'page' : undefined} onClick={() => { setView('stage'); setPanel('chat'); setMobilePanel('chat'); }}><MessageCircle size={18} /><span>Chat</span></Button><Button variant={view === 'stage' && mobilePanel === 'people' ? 'secondary' : 'ghost'} className={view === 'stage' && mobilePanel === 'people' ? 'active' : ''} aria-current={view === 'stage' && mobilePanel === 'people' ? 'page' : undefined} onClick={() => { setView('stage'); setPanel('people'); setMobilePanel('people'); }}><Users size={18} /><span>People</span></Button></>}<Button variant={view === 'schedule' ? 'secondary' : 'ghost'} className={view === 'schedule' ? 'active' : ''} aria-current={view === 'schedule' ? 'page' : undefined} onClick={() => nav('schedule')}><Calendar size={18} /><span>Sessions</span></Button></nav>
    {live && view === 'stage' && <div className="floating-reactions" aria-hidden="true">{recentReactions.map((reaction, index) => <span className="reaction-float" key={reaction.id} style={{ left: `${20 + index % 7 * 9}%`, animationDelay: `${Math.min(index * .08, .4)}s` }}>{reaction.emoji}</span>)}</div>}
    {settings && dialogScope.current(settings) && <AudioSettings key={`${scopeKey}/${settings.revision}`} media={media} onClose={() => closeDialog(settings)} localPreview={previewState} />}
    {editingSchedule && dialogScope.current(editingSchedule.ticket) && <ScheduleEditor key={`${scopeKey}/${editingSchedule.schedule?.id ?? 'new'}/${editingSchedule.ticket.revision}`} schedule={editingSchedule.schedule} command={scopedCommand} onClose={() => closeDialog(editingSchedule.ticket)} />}
    {opening && dialogScope.current(opening) && <OpenSession key={`${scopeKey}/${opening.revision}`} onClose={() => closeDialog(opening)} open={async (title, mode) => { await scopedCommand({ type: 'session.open', title, mode }); if (dialogScope.current(opening)) { closeDialog(opening); setView('stage'); } }} />}
    {confirming && dialogScope.current(confirming.ticket) && <AlertDialog open onOpenChange={open => { if (!open && confirmInFlight.current !== confirming.ticket) closeDialog(confirming.ticket); }}><AlertDialogContent onOpenAutoFocus={event => { event.preventDefault(); cancelConfirm.current?.focus(); }} onEscapeKeyDown={event => { if (confirmInFlight.current === confirming.ticket) event.preventDefault(); }}><AlertDialogHeader><AlertDialogTitle>{confirming.title}</AlertDialogTitle><AlertDialogDescription>{confirming.detail}</AlertDialogDescription></AlertDialogHeader>{confirmError && <div className="notice error" role="alert">{confirmError}{verificationRetrySeconds > 0 && ` Retry available in ${retryLabel(verificationRetrySeconds)}.`}</div>}<AlertDialogFooter><AlertDialogCancel ref={cancelConfirm} disabled={confirmBusy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={confirmBusy || verificationRetrySeconds > 0} onClick={event => { event.preventDefault(); void performConfirm(); }}>{confirmBusy ? 'Working…' : confirming.actionLabel}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}
  </div></MediaProvider></TooltipProvider>;
}

function SpeakerCard({ person, ownId, room }: { person: ParticipantView; ownId: string; room: Room }) {
  const [speaking, setSpeaking] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  useEffect(() => {
    const update = () => {
      const mediaState = participantMediaState(person.devices, [room.localParticipant, ...room.remoteParticipants.values()]);
      setSpeaking(mediaState.speaking);
      setMicrophoneEnabled(mediaState.microphoneEnabled);
    };
    update();
    const events = [RoomEvent.ActiveSpeakersChanged, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected] as const;
    events.forEach(event => room.on(event, update));
    return () => { events.forEach(event => room.off(event, update)); };
  }, [person.userId, person.devices, room]);
  const isOwn = person.userId === ownId;
  return <article className={`speaker-card ${speaking ? 'speaking' : ''}`}><div className="speaker-avatar-wrap"><Avatar name={person.displayName} image={person.avatarUrl} size="large" userId={person.userId} /><span className={`mic-indicator ${speaking ? 'speaking' : ''}`} aria-label={person.microphoneBlocked ? 'Microphone restricted' : microphoneEnabled ? 'Microphone on' : 'Microphone off'}>{person.microphoneBlocked ? <Lock size={10} /> : microphoneEnabled ? <Mic size={11} /> : <MicOff size={11} />}</span></div><div className="speaker-details"><strong>{person.displayName}{isOwn && <span className="you-label">you</span>}</strong><small>{person.isOwner ? <><Crown size={10} />Owner</> : person.isAdmin ? <><Shield size={10} />Admin</> : person.microphoneBlocked ? 'Mic restricted' : 'Speaker'}</small></div></article>;
}

function WaitingRoom({ state, onOpen, onSchedule, command }: { state: RoomSnapshot; onOpen: () => void; onSchedule: (schedule?: ScheduledSession) => void; command: ReturnType<typeof useRoomModel>['command'] }) {
  const admin = state.self.isAdmin || state.self.isOwner;
  return <div className="waiting-layout"><Card className="waiting-card"><div><h1>Session closed</h1><p>{admin ? 'Open a session to welcome members before going live. You’ll join automatically with your microphone off.' : 'An admin will open the next session.'}</p></div>{admin && <Button disabled={state.cleanupPending} onClick={onOpen}><Radio size={16} />Open session</Button>}</Card><SchedulePanel state={state} command={command} onEdit={onSchedule} compact /></div>;
}

function OpenSession({ onClose, open }: { onClose: () => void; open: (title: string, mode: RoomMode) => Promise<void> }) {
  const titleId = useId();
  const [title, setTitle] = useState('Community room');
  const [mode, setMode] = useState<RoomMode>(DEFAULT_ROOM_MODE);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { await open(title, mode); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'The session could not be opened. Try again.'); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  return <Modal title="Open session" description="Members can join before the session goes live. You will join automatically with your microphone off." onClose={onClose} busy={busy} dismissible={!busy}><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="modal-body"><div className="field"><Label htmlFor={titleId}>Session title</Label><Input id={titleId} autoFocus maxLength={100} value={title} required disabled={busy} onChange={event => setTitle(event.target.value)} /></div><SpeakingModeControl value={mode} onChange={setMode} disabled={busy} /><p className="form-hint">{speakingModeDescription(mode)} Microphones start off. Going live keeps this choice.</p>{error && <div className="notice error" role="alert">{error}</div>}</div><div className="modal-footer"><Button variant="outline" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !title.trim()}>{busy ? 'Opening…' : 'Open session'}</Button></div></form></Modal>;
}

function AudioSettings({ media, onClose, localPreview }: { media: ReturnType<typeof useStageMedia>; onClose: () => void; localPreview: boolean }) {
  const settingsId = useId();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [phase, setPhase] = useState<MicrophoneTestPhase>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const [microphoneTest] = useState(() => new MicrophoneTestController<MediaStream>(next => {
    if (mounted.current) { setPhase(next); if (next === 'idle') setLevel(0); }
  }, reason => {
    if (mounted.current) setError(reason instanceof Error ? reason.message : 'Microphone permission was not granted.');
  }));
  const enumerate = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const next = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
      if (mounted.current) setDevices(next);
    } catch { if (mounted.current) setError('Microphone devices could not be listed. You can still try the system default.'); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void enumerate();
    return () => { mounted.current = false; microphoneTest.stop(); };
  }, [enumerate, microphoneTest]);
  useEffect(() => { microphoneTest.stop(); }, [media.deviceId, microphoneTest]);
  const stop = () => microphoneTest.stop();
  const close = () => { stop(); onClose(); };
  const testing = phase === 'active';
  const test = async () => {
    if (microphoneTest.running) { stop(); return; }
    setError('');
    await microphoneTest.start(
      () => navigator.mediaDevices.getUserMedia({ audio: media.deviceId === 'default' ? true : { deviceId: { exact: media.deviceId } } }),
      stream => createMicrophoneMeter(stream, value => { if (mounted.current) setLevel(value); }, undefined, reason => {
        stop();
        if (mounted.current) setError(reason instanceof Error ? reason.message : 'Microphone testing stopped. Please try again.');
      }),
    );
    if (mounted.current && microphoneTest.running) await enumerate();
  };
  return <Modal title="Audio & preferences" description="Choose a microphone, test its input locally, and set screen-sharing preferences." onClose={close}><div className="modal-body settings-grid"><p className="settings-intro">Test your microphone locally. Joining the room never turns it on.</p><section><h3>Microphone</h3><div className="field"><Label htmlFor={`${settingsId}-input`}>Input device</Label><Select value={media.deviceId} disabled={media.microphonePending} onValueChange={value => { stop(); setError(''); void media.setDeviceId(value).catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : 'The microphone input could not be switched.'); }); }}><SelectTrigger id={`${settingsId}-input`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">System default microphone</SelectItem>{devices.filter(device => device.deviceId !== 'default').map((device, index) => <SelectItem key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</SelectItem>)}</SelectContent></Select></div><div className="mic-test"><div className="mic-meter" role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level)}><span style={{ width: `${level}%` }} /></div><Button variant="outline" size="sm" disabled={media.microphonePending || !navigator.mediaDevices?.getUserMedia} onClick={() => void test()}>{phase === 'pending' ? 'Cancel test' : testing ? 'Stop test' : 'Test microphone'}</Button></div>{phase !== 'idle' && <p className="form-hint" role="status">{phase === 'pending' ? 'Waiting for microphone permission. You can cancel this test.' : 'Speak to check the input level. Audio stays on this device.'}</p>}</section><section><h3>Screen sharing</h3><div className="field"><Label htmlFor={`${settingsId}-quality`}>Sharing quality</Label><Select value={media.shareQuality} onValueChange={media.setShareQuality}><SelectTrigger id={`${settingsId}-quality`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="balanced">Balanced · 720p / up to 1.5 Mbps</SelectItem><SelectItem value="detail">Detailed text · 1080p / up to 3 Mbps</SelectItem></SelectContent></Select></div><div className="checkbox-field"><Checkbox id={`${settingsId}-shared-audio`} checked={media.shareAudio} onCheckedChange={checked => media.setShareAudio(checked === true)} /><Label htmlFor={`${settingsId}-shared-audio`}>Include shared audio when supported</Label></div><p className="form-hint">For Chrome tab audio, choose a browser tab and enable “Share tab audio” in the chooser. Your microphone is separate.</p></section>{localPreview && <div className="notice warning">Preview uses fictional accounts. Discord access checks are not active.</div>}{error && <div className="notice error" role="alert">{error}</div>}</div><div className="modal-footer"><Button onClick={close}>Done</Button></div></Modal>;
}

function AuthScreen({ model }: { model: ReturnType<typeof useRoomModel> }) {
  const { boot, error } = model;
  const retrySeconds = useRetrySeconds(boot?.auth.retryAt);
  const [busy, setBusy] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const signInPreview = async (persona: string) => {
    setBusy(persona);
    try { await previewLogin(persona); await model.initialize(); }
    catch (reason) { if (mounted.current) model.setError(reason instanceof Error ? reason.message : 'Preview login failed.'); }
    finally { if (mounted.current) setBusy(''); }
  };
  const unavailable = boot?.auth.status === 'verification-unavailable';
  const nonmember = boot?.auth.status === 'nonmember';
  const waitingForRoom = boot?.auth.status === 'authenticated';
  return <main className="auth-screen"><div className="auth-top"><Brand /></div><section className="auth-layout"><Card className="auth-card"><div className="auth-card-content"><h1>{!boot ? 'App unavailable' : waitingForRoom ? 'Room unavailable' : nonmember ? 'Members only' : unavailable ? 'Verification paused' : 'Sign in'}</h1><p>{!boot ? 'The local app could not be reached. Check that it’s running, then retry.' : waitingForRoom ? 'The room could not be loaded. Try reconnecting.' : nonmember ? 'Your Discord account is not a member of this community.' : unavailable ? 'Discord verification is temporarily unavailable. Wait for the cooldown before retrying.' : 'Use your Discord account to access your community’s room.'}</p>
    {!waitingForRoom && !unavailable && boot?.configuration.discordConfigured && <Button asChild className="discord-button"><a href={apiUrl('/api/auth/discord')}><MessageCircle size={18} />{nonmember ? 'Try another Discord account' : 'Continue with Discord'}<ArrowRight size={16} /></a></Button>}
    {boot && !waitingForRoom && !unavailable && !boot.configuration.discordConfigured && !boot.localPreview && <div className="notice info">Discord login is not configured. Complete the local setup first.</div>}
    {(!boot || unavailable || waitingForRoom || !!error) && <Button variant="outline" disabled={retrySeconds > 0} onClick={() => void model.initialize().catch(() => undefined)}><RefreshCw size={16} />{retrySeconds > 0 ? `Retry in ${retryLabel(retrySeconds)}` : unavailable ? 'Retry verification' : 'Try again'}</Button>}
    {boot?.localPreview && !waitingForRoom && <div className="preview-login"><p>Local preview · fictional identities</p><div className="persona-buttons">{[{ id: 'owner', title: 'Owner' }, { id: 'admin', title: 'Admin' }, { id: 'member', title: 'Member' }].map(persona => <Button variant="outline" key={persona.id} disabled={!!busy} onClick={() => void signInPreview(persona.id)}>{busy === persona.id ? 'Signing in…' : persona.title}</Button>)}</div></div>}
    {error && <div className="notice error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    <p className="form-hint"><Lock size={12} />Access requires verified community membership.</p>
    </div></Card></section></main>;
}

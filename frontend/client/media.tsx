import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RoomAudioRenderer, RoomContext, VideoTrack, useTracks } from '@livekit/components-react';
import { ConnectionState, Room, RoomEvent, Track, TrackEvent, createLocalScreenTracks, type LocalTrack } from 'livekit-client';
import { Grid2X2, Maximize2, Minimize2, Monitor, MonitorUp, Pin, Radio, Volume2 } from 'lucide-react';
import type { Command, CommandResult, RoomSnapshot } from '../../shared/types';
import { getMediaToken } from './api';
import { ScreenCaptureController } from './screen-capture-controller';
import { RoomAudioPlaybackObserver } from './room-audio-playback';
import { matchesOpenedSessionJoin, type OpenedSessionJoinTicket } from './opened-session-join';

type CommandHandler = (command: Command) => Promise<CommandResult>;
const admissionScope = (state: RoomSnapshot | null) => state?.session && state.self.admission && !state.self.admission.revoked ? `${state.self.userId}/${state.session.id}/${state.self.admission.id}` : null;
function mediaMessage(reason: unknown) {
  if (reason instanceof DOMException && reason.name === 'NotAllowedError') return 'Permission was not granted. You can try again when you’re ready.';
  return reason instanceof Error ? reason.message : 'The media connection could not be completed.';
}

/** A connected SDK room may outlive the application session snapshot that replaced it. */
export async function prepareMediaRoom(room: Pick<Room, 'state' | 'name' | 'disconnect'>, roomName: string, current: () => boolean): Promise<boolean> {
  if (!current()) return false;
  if (room.state !== ConnectionState.Disconnected && room.name !== roomName) await room.disconnect();
  return current();
}

export function useStageMedia(state: RoomSnapshot | null, command: CommandHandler, configured: boolean, notify: (message: string) => void) {
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true }));
  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [microphone, setMicrophone] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [deviceId, commitDeviceId] = useState('default');
  const [shareAudio, setShareAudio] = useState(false);
  const [shareQuality, setShareQuality] = useState('balanced');
  const [sharePending, setSharePending] = useState(false);
  const [microphonePending, setMicrophonePending] = useState(false);
  const microphoneBusy = useRef(false);
  const joinBusy = useRef(false);
  const joinGeneration = useRef(0);
  const mounted = useRef(true);
  const latest = useRef(state);
  const callbacks = useRef({ command, notify });
  latest.current = state;
  callbacks.current = { command, notify };
  const [playback] = useState(() => new RoomAudioPlaybackObserver(room,
    () => mounted.current && room.state !== ConnectionState.Disconnected && room.name === latest.current?.session?.roomName && admissionScope(latest.current)
      ? `${admissionScope(latest.current)}/${latest.current?.self.deviceId}` : null,
    setAudioEnabled,
  ));
  const [capture] = useState(() => new ScreenCaptureController<LocalTrack>({
    scope: () => admissionScope(latest.current),
    allowed: scope => mounted.current && admissionScope(latest.current) === scope && !!latest.current?.self.canShare && room.state === ConnectionState.Connected,
    reserve: async () => {
      const result = await callbacks.current.command({ type: 'share.reserve' });
      if (!result.reservation) throw new Error('No screen reservation was returned. Please try again.');
      return result.reservation.reservationId;
    },
    confirm: async reservationId => { await callbacks.current.command({ type: 'share.confirm', reservationId }); },
    release: async () => { await callbacks.current.command({ type: 'share.release' }); },
    unpublish: async track => { await room.localParticipant.unpublishTrack(track); },
    onEnded: (tracks, ended) => { tracks.find(track => track.kind === Track.Kind.Video)?.once(TrackEvent.Ended, ended); },
    changed: value => { if (mounted.current) { setSharePending(value.pending); setSharing(value.active); } },
    failed: reason => { if (mounted.current) callbacks.current.notify(mediaMessage(reason)); },
  }));
  useEffect(() => {
    mounted.current = true;
    playback.start();
    const update = () => {
      setConnection(room.state);
      setMicrophone(room.localParticipant.isMicrophoneEnabled);
      setSharing(room.localParticipant.isScreenShareEnabled);
      playback.refresh();
      if (room.state === ConnectionState.Disconnected) void capture.stop();
    };
    room.on(RoomEvent.ConnectionStateChanged, update);
    room.on(RoomEvent.LocalTrackPublished, update);
    room.on(RoomEvent.LocalTrackUnpublished, update);
    room.on(RoomEvent.TrackMuted, update);
    room.on(RoomEvent.TrackUnmuted, update);
    return () => {
      mounted.current = false;
      playback.stop();
      joinGeneration.current++;
      room.off(RoomEvent.ConnectionStateChanged, update);
      room.off(RoomEvent.LocalTrackPublished, update);
      room.off(RoomEvent.LocalTrackUnpublished, update);
      room.off(RoomEvent.TrackMuted, update);
      room.off(RoomEvent.TrackUnmuted, update);
      void capture.stop();
      void room.disconnect();
    };
  }, [room, capture, playback]);
  useEffect(() => {
    capture.reconcile();
    playback.refresh();
    if (!state?.session || !state.self.admission) {
      joinGeneration.current++;
      void capture.stop();
      if (room.state !== ConnectionState.Disconnected) void room.disconnect();
    }
    if ((!state?.self.canSpeak || !state.self.microphoneOwned) && room.localParticipant.isMicrophoneEnabled) void room.localParticipant.setMicrophoneEnabled(false);
    if (!state?.self.canShare) void capture.stop();
  }, [state?.session?.id, state?.self.admission?.id, state?.self.admission?.revoked, state?.self.canSpeak, state?.self.canShare, state?.self.microphoneOwned, room, capture, playback]);

  const enableAudio = useCallback(async () => {
    try { await playback.startAudio(); } catch (reason) { notify(mediaMessage(reason)); }
  }, [playback, notify]);
  const join = useCallback(async (opened?: OpenedSessionJoinTicket) => {
    if (joinBusy.current) return;
    if (opened && !matchesOpenedSessionJoin(opened, latest.current)) return;
    joinBusy.current = true;
    const generation = ++joinGeneration.current;
    const sessionId = latest.current?.session?.id;
    const userId = latest.current?.self.userId;
    const clientDeviceId = latest.current?.self.deviceId;
    const current = () => mounted.current && generation === joinGeneration.current && latest.current?.session?.id === sessionId
      && latest.current?.self.userId === userId && latest.current?.self.deviceId === clientDeviceId
      && (!opened || matchesOpenedSessionJoin(opened, latest.current));
    setJoining(true);
    try {
      // Opening already admitted this exact device. Only ordinary joins need a new admission command.
      if (!opened) await command({ type: 'room.join' });
      if (!current()) return;
      if (configured) {
        const roomName = latest.current?.session?.roomName;
        if (!roomName || !await prepareMediaRoom(room, roomName, current)) return;
        if (room.state === ConnectionState.Disconnected) {
          const credentials = await getMediaToken();
          if (!current()) return;
          await room.connect(credentials.serverUrl, credentials.token, { autoSubscribe: true });
          if (!current()) { await room.disconnect(); return; }
        }
        await playback.startAudio();
      }
    } catch (reason) { if (current()) notify(mediaMessage(reason)); }
    finally { joinBusy.current = false; if (mounted.current) setJoining(false); }
  }, [command, configured, notify, room, playback]);
  const leave = useCallback(async () => {
    joinGeneration.current++;
    // stop() stops local tracks synchronously; reservation cleanup can finish in parallel.
    void capture.stop();
    await room.disconnect();
    try { await command({ type: 'room.leave' }); } catch (reason) { notify(mediaMessage(reason)); }
  }, [command, room, notify, capture]);
  const setDeviceId = useCallback(async (nextDeviceId: string) => {
    if (microphoneBusy.current) return;
    microphoneBusy.current = true;
    setMicrophonePending(true);
    const generation = joinGeneration.current;
    const scope = () => `${latest.current?.self.userId ?? ''}/${latest.current?.self.deviceId ?? ''}/${admissionScope(latest.current) ?? 'closed'}`;
    const startedScope = scope();
    const tracks = [...room.localParticipant.audioTrackPublications.values()]
      .filter(publication => publication.source === Track.Source.Microphone)
      .flatMap(publication => publication.audioTrack ? [publication.audioTrack] : []);
    const current = () => mounted.current && generation === joinGeneration.current && scope() === startedScope
      && (!tracks.length || room.state !== ConnectionState.Disconnected);
    try {
      // The SDK updates existing microphone tracks, including a muted track's
      // next capture constraints. Without a track it changes defaults only.
      // Merely passing capture options to setMicrophoneEnabled(true) is not
      // enough: the SDK ignores those options when reusing a publication.
      const switched = await room.switchActiveDevice('audioinput', nextDeviceId);
      if (!current()) { tracks.forEach(track => track.stop()); return; }
      if (!switched) throw new Error('The microphone input could not be switched. Choose another input or try again.');
      commitDeviceId(nextDeviceId);
    } catch (reason) {
      if (!current()) { tracks.forEach(track => track.stop()); return; }
      throw reason;
    } finally {
      microphoneBusy.current = false;
      if (mounted.current) setMicrophonePending(false);
    }
  }, [room]);
  const toggleMic = useCallback(async () => {
    if (microphoneBusy.current) return;
    microphoneBusy.current = true;
    setMicrophonePending(true);
    const scope = admissionScope(latest.current);
    const current = () => mounted.current && !!scope && admissionScope(latest.current) === scope;
    try {
      if (room.localParticipant.isMicrophoneEnabled) {
        await room.localParticipant.setMicrophoneEnabled(false);
        if (current()) await command({ type: 'mic.release' });
        return;
      }
      if (room.state !== ConnectionState.Connected) throw new Error('Join the audio connection before enabling your microphone.');
      const acquired = await command({ type: 'mic.acquire' });
      const policy = () => latest.current && latest.current.revision >= acquired.snapshot.revision ? latest.current : acquired.snapshot;
      if (!current() || !policy().self.canSpeak || room.state !== ConnectionState.Connected) {
        if (current()) await command({ type: 'mic.release' });
        return;
      }
      try { await room.localParticipant.setMicrophoneEnabled(true, { deviceId }); }
      catch (reason) { if (current()) await command({ type: 'mic.release' }).catch(() => undefined); throw reason; }
      if (!current() || !policy().self.canSpeak || !policy().self.microphoneOwned) {
        await room.localParticipant.setMicrophoneEnabled(false);
        if (current()) await command({ type: 'mic.release' });
      }
    } catch (reason) { if (current()) notify(mediaMessage(reason)); }
    finally { microphoneBusy.current = false; if (mounted.current) setMicrophonePending(false); }
  }, [command, deviceId, room, notify]);
  const toggleShare = useCallback(async () => {
    if (capture.active || capture.pending) { await capture.stop(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { notify('Screen broadcasting is not supported in this browser. You can still view, chat, and use an approved microphone.'); return; }
    if (room.state !== ConnectionState.Connected) { notify('Join the audio connection before sharing your screen.'); return; }
    let capturedAudio = false;
    const started = await capture.start(
      () => createLocalScreenTracks({
        audio: shareAudio,
        video: shareAudio ? { displaySurface: 'browser' } : true,
        systemAudio: shareAudio ? 'include' : 'exclude',
        resolution: { width: shareQuality === 'detail' ? 1920 : 1280, height: shareQuality === 'detail' ? 1080 : 720, frameRate: 15 },
      }).then(tracks => { capturedAudio = tracks.some(track => track.kind === Track.Kind.Audio); return tracks; }),
      async track => { await room.localParticipant.publishTrack(track, {
        source: track.kind === Track.Kind.Audio ? Track.Source.ScreenShareAudio : Track.Source.ScreenShare,
        ...(track.kind === Track.Kind.Video ? { videoEncoding: { maxBitrate: shareQuality === 'detail' ? 3_000_000 : 1_500_000, maxFramerate: 15 } } : {}),
      }); },
    );
    if (started && shareAudio && !capturedAudio) notify('Your screen is shared without audio. To include tab audio in Chrome, choose a browser tab and enable “Share tab audio” in the chooser.');
  }, [capture, room, shareAudio, shareQuality, notify]);
  return { room, connection, microphone, sharing, sharePending, microphonePending, joining, audioEnabled, join, leave, toggleMic, toggleShare, enableAudio, deviceId, setDeviceId, shareAudio, setShareAudio, shareQuality, setShareQuality };
}

export function MediaProvider({ room, children }: { room: Room; children: ReactNode }) {
  return <RoomContext.Provider value={room}>{children}<RoomAudioRenderer /></RoomContext.Provider>;
}

export function ScreenWorkspace({ state, command, connected, canShare, sharePending, onShare }: { state: RoomSnapshot; command: CommandHandler; connected: boolean; canShare: boolean; sharePending: boolean; onShare: () => void }) {
  const tracks = useTracks([Track.Source.ScreenShare, Track.Source.ScreenShareAudio], { onlySubscribed: false });
  const actualTracks = tracks.filter(track => track.source === Track.Source.ScreenShare && track.publication);
  const hasSharedAudio = (identity: string) => tracks.some(track => track.source === Track.Source.ScreenShareAudio && track.participant.identity === identity && track.publication && !track.publication.isMuted);
  const [selection, setSelection] = useState('');
  const [grid, setGrid] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const fullscreenMounted = useRef(true);
  useEffect(() => {
    fullscreenMounted.current = true;
    const element = root.current;
    const update = () => setFullscreen(!!element && document.fullscreenElement === element);
    document.addEventListener('fullscreenchange', update);
    update();
    return () => {
      fullscreenMounted.current = false;
      document.removeEventListener('fullscreenchange', update);
      if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  const toggleFullscreen = async () => {
    const element = root.current;
    if (!element) return;
    setFullscreenError('');
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      else {
        if (!element.requestFullscreen) throw new Error('Fullscreen is not supported in this browser.');
        await element.requestFullscreen();
      }
    } catch (reason) {
      if (fullscreenMounted.current) setFullscreenError(reason instanceof Error ? reason.message : 'Fullscreen could not be changed. Please try again.');
    }
  };
  const fullscreenLabel = fullscreen ? 'Exit fullscreen' : 'Fullscreen screens';
  const spotlight = state.shares.find(share => share.reservationId === state.session?.spotlightReservationId);
  const spotlightTrack = spotlight ? actualTracks.find(track => track.participant.identity === spotlight.identity) : undefined;
  const focused = spotlightTrack ?? actualTracks.find(track => track.publication.trackSid === selection) ?? actualTracks[0];
  const activeShares = state.shares.filter(share => share.status === 'active');
  const chooseSpotlight = (identity: string) => {
    const reservation = state.shares.find(share => share.identity === identity);
    if (reservation) void command({ type: 'spotlight.set', reservationId: reservation.reservationId }).catch(() => undefined);
  };
  return <div className="stage-workspace" ref={root}>
    <div className="stage-topbar"><span><Monitor size={14} /> Shared screens <span className="subtle-count">{activeShares.length}/3</span></span><div className="stage-actions">
      {spotlight && <span className="spotlight-note"><Pin size={12} /> Spotlight by admin</span>}
      <Tooltip><TooltipTrigger asChild><Button variant={grid ? 'secondary' : 'ghost'} size="icon" aria-pressed={grid} aria-label="Toggle screen grid" onClick={() => setGrid(!grid)} disabled={actualTracks.length < 2 || !!spotlight}><Grid2X2 size={16} /></Button></TooltipTrigger><TooltipContent>Toggle screen grid</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={fullscreenLabel} title={fullscreenLabel} aria-pressed={fullscreen} onClick={() => { void toggleFullscreen(); }}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</Button></TooltipTrigger><TooltipContent>{fullscreenLabel}</TooltipContent></Tooltip>
    </div></div>
    {fullscreenError && <p role="alert">{fullscreenError}</p>}
    {spotlight && state.self.isAdmin && <div className="spotlight-banner">Everyone is following {spotlight.displayName}’s screen.<Button variant="ghost" onClick={() => void command({ type: 'spotlight.set', reservationId: null }).catch(() => undefined)}>Clear spotlight</Button></div>}
    <div className={grid && !spotlight ? 'screen-stage screen-grid' : 'screen-stage'}>
      {focused ? (grid && !spotlight ? actualTracks : [focused]).map(track => <div className="share-tile" key={track.publication.trackSid}>
        <VideoTrack trackRef={track} manageSubscription={true} />
        <div className="share-label"><MonitorUp size={13} /><span>{track.participant.name || track.participant.identity}</span>{hasSharedAudio(track.participant.identity) && <span className="shared-audio-label"><Volume2 size={12} />Shared audio</span>}{state.self.isAdmin && <Button variant="ghost" title="Spotlight for everyone" aria-label={`Spotlight ${track.participant.name || 'screen'}`} onClick={() => chooseSpotlight(track.participant.identity)}><Pin size={12} /></Button>}</div>
      </div>) : <div className="screen-placeholder">
        <Monitor size={28} strokeWidth={1.5} aria-hidden="true" />
        <h2>{activeShares.length ? 'Connecting to shared screens' : 'No screen shared'}</h2>
        <p>{activeShares.length ? 'Screens will appear when the room connection is ready.' : 'Shared screens appear here. Up to three people can present at once.'}</p>
        {canShare && connected ? <Button variant="outline" onClick={onShare}><MonitorUp size={16} /> {sharePending ? 'Cancel share' : 'Share screen'}</Button> : <span className="stage-hint"><Radio size={13} /> {connected ? 'An admin can invite you to present.' : state.self.admission ? 'Connect to the room to view screens and listen.' : 'Join the room to participate.'}</span>}
      </div>}
    </div>
    {actualTracks.length > 1 && !grid && <div className="share-previews">{actualTracks.map(track => <Button variant="ghost" key={track.publication.trackSid} className={`share-preview ${track === focused ? 'active' : ''}`} disabled={!!spotlight} onClick={() => setSelection(track.publication.trackSid)}><span className="preview-image"><VideoTrack trackRef={track} manageSubscription={false} /></span><span>{track.participant.name || 'Shared screen'}</span><span className="preview-status">{track === focused ? 'Viewing' : 'Switch to'}</span></Button>)}</div>}
  </div>;
}

export function AudioNotice({ onEnable }: { onEnable: () => void }) {
  return <Button variant="outline" className="audio-notice" onClick={onEnable}><Volume2 size={17} /><span>Enable room audio</span></Button>;
}

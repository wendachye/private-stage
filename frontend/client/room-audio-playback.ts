import { RoomEvent, Track, TrackEvent, type RemoteTrack, type Room } from 'livekit-client';

interface PlaybackTrack {
  failed: boolean;
  failure: number;
  started: () => void;
  denied: () => void;
}

/** Observes the SDK playback boundary used by the room's recovery notice. */
export class RoomAudioPlaybackObserver {
  private listening = false;
  private roomEnabled = false;
  private observedScope: string | null = null;
  private generation = 0;
  private readonly tracks = new Map<RemoteTrack, PlaybackTrack>();

  constructor(
    private readonly room: Room,
    private readonly scope: () => string | null,
    private readonly changed: (enabled: boolean) => void,
  ) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, this.statusChanged);
    this.room.on(RoomEvent.TrackSubscribed, this.subscribed);
    this.room.on(RoomEvent.TrackUnsubscribed, this.unsubscribed);
    this.room.on(RoomEvent.ConnectionStateChanged, this.refresh);
    this.refresh();
  }

  stop(): void {
    this.listening = false;
    this.room.off(RoomEvent.AudioPlaybackStatusChanged, this.statusChanged);
    this.room.off(RoomEvent.TrackSubscribed, this.subscribed);
    this.room.off(RoomEvent.TrackUnsubscribed, this.unsubscribed);
    this.room.off(RoomEvent.ConnectionStateChanged, this.refresh);
    this.clearTracks();
  }

  refresh = (): void => { this.statusChanged(this.room.canPlaybackAudio); };

  async startAudio(): Promise<void> {
    if (!this.reconcile()) return;
    const generation = this.generation, scope = this.observedScope;
    const failed = [...this.tracks].filter(([, state]) => state.failed).map(([track, state]) => ({
      track, state, failure: state.failure, elements: [...track.attachedElements],
    }));
    const current = () => this.listening && generation === this.generation && scope === this.scope();
    try { await this.room.startAudio(); }
    catch (error) { if (current()) throw error; return; }
    if (!current()) return;
    // The SDK retries native element.play() directly: it emits room success,
    // but no track success. Clear only failures that this retry really played.
    for (const retry of failed) {
      const elements = retry.track.attachedElements;
      if (this.tracks.get(retry.track) === retry.state && retry.state.failure === retry.failure
        && elements.length > 0 && elements.length === retry.elements.length
        && elements.every(element => retry.elements.includes(element) && !element.paused && !element.ended)) {
        retry.state.failed = false;
      }
    }
    this.refresh();
  }

  private statusChanged = (enabled: boolean) => {
    if (!this.listening) return;
    this.reconcile();
    this.roomEnabled = enabled;
    this.publish();
  };

  private publish(): void {
    if (this.listening) this.changed(!!this.observedScope && this.observedScope === this.scope()
      && this.roomEnabled && ![...this.tracks.values()].some(track => track.failed));
  }

  private reconcile(): boolean {
    if (!this.listening) return false;
    const scope = this.scope();
    if (scope !== this.observedScope) {
      this.clearTracks();
      this.observedScope = scope;
      if (scope) for (const participant of this.room.remoteParticipants.values()) {
        for (const publication of participant.audioTrackPublications.values()) {
          if (publication.track) this.observe(publication.track);
        }
      }
    }
    return !!scope;
  }

  private subscribed = (track: RemoteTrack) => {
    if (this.reconcile()) this.observe(track);
    this.publish();
  };

  private observe(track: RemoteTrack): void {
    if (track.kind !== Track.Kind.Audio || this.tracks.has(track)) return;
    const generation = this.generation;
    const valid = () => this.listening && generation === this.generation && this.observedScope === this.scope()
      && this.tracks.get(track) === state;
    const state: PlaybackTrack = {
      failed: track.attachedElements.some(element => element.paused && !element.ended && element.readyState >= 2),
      failure: 0,
      started: () => { if (valid()) { state.failed = false; this.publish(); } },
      denied: () => { if (valid()) { state.failed = true; state.failure++; this.publish(); } },
    };
    this.tracks.set(track, state);
    track.on(TrackEvent.AudioPlaybackStarted, state.started);
    track.on(TrackEvent.AudioPlaybackFailed, state.denied);
  }

  private unsubscribed = (track: RemoteTrack) => {
    this.remove(track);
    this.publish();
  };

  private remove(track: RemoteTrack): void {
    const state = this.tracks.get(track);
    if (!state) return;
    track.off(TrackEvent.AudioPlaybackStarted, state.started);
    track.off(TrackEvent.AudioPlaybackFailed, state.denied);
    this.tracks.delete(track);
  }

  private clearTracks(): void {
    for (const track of this.tracks.keys()) this.remove(track);
    this.observedScope = null;
    this.generation++;
  }
}

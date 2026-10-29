import type { MediaPolicy, MediaSource } from '../../../shared/types.js';

export class MediaPolicyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'MediaPolicyError'; }
}

export interface PublishIntent {
  cid: string;
  sid?: string;
  source: MediaSource;
  kind: 'audio' | 'video';
}

export interface TrackLease extends PublishIntent {
  identity: string;
  accountId: string;
  roomName: string;
  reservationId?: string;
  createdAt: number;
  published: boolean;
  /** AddTrack acknowledgement precedes media negotiation; metadata must observe the actual track separately. */
  observed?: { participantSid: string; version: number };
}

/** One-process, synchronous publication gate. Domain reservations are an additional prerequisite. */
export class PublicationGuard {
  private readonly tracks = new Map<string, TrackLease>();
  private readonly aliases = new Map<string, string>();
  constructor(private readonly maxScreens = 3, private readonly clock = () => Date.now()) {}

  private key(identity: string, cid: string) { return `${identity}\u0000${cid}`; }
  private canonicalKey(identity: string, cid: string) { const key = this.key(identity, cid); return this.aliases.get(key) ?? key; }
  private pruneAliases() { for (const [alias, original] of this.aliases) if (!this.tracks.has(original)) this.aliases.delete(alias); }

  reserve(policy: MediaPolicy, intent: PublishIntent): TrackLease {
    if (!policy.active || !policy.allowedSources.includes(intent.source)) {
      throw new MediaPolicyError('source_not_allowed', 'Publishing this source is not permitted.');
    }
    if (!intent.cid || intent.cid.length > 256 || /[\u0000-\u001f]/u.test(intent.cid)) {
      throw new MediaPolicyError('invalid_track', 'A valid track identifier is required.');
    }
    const expected = intent.source === 'screen_share' ? 'video' : 'audio';
    if (intent.kind !== expected) throw new MediaPolicyError('invalid_track_kind', 'The source and track kind do not match.');
    const existing = this.tracks.get(this.canonicalKey(policy.identity, intent.cid));
    if (existing) {
      if (existing.source !== intent.source || existing.kind !== intent.kind || (intent.sid && existing.sid !== intent.sid)) {
        throw new MediaPolicyError('track_identity_changed', 'A track identifier cannot change its source or server identity.');
      }
      return { ...existing };
    }
    // Additional codecs for an existing simulcast publication refer to its known server SID.
    if (intent.sid) {
      const same = [...this.tracks.values()].find(track => track.identity === policy.identity && track.sid === intent.sid);
      if (!same || same.source !== intent.source || same.kind !== intent.kind) {
        throw new MediaPolicyError('unknown_track_sid', 'Only an existing publication can add a codec.');
      }
      const original = this.key(same.identity, same.cid);
      if ([...this.aliases.values()].filter(key => key === original).length >= 8) throw new MediaPolicyError('codec_limit', 'This publication has too many codec identifiers.');
      this.aliases.set(this.key(policy.identity, intent.cid), original);
      return { ...same };
    }
    const inRoom = [...this.tracks.values()].filter(track => track.roomName === policy.roomName);
    if (inRoom.some(track => track.accountId === policy.accountId && track.source === intent.source)) {
      throw new MediaPolicyError('account_source_limit', 'This account already has a publication of that source.');
    }
    if (intent.source === 'screen_share' && inRoom.filter(track => track.source === 'screen_share').length >= this.maxScreens) {
      throw new MediaPolicyError('room_screen_limit', 'All screen-sharing slots are occupied.');
    }
    const lease: TrackLease = { ...intent, identity: policy.identity, accountId: policy.accountId, roomName: policy.roomName, reservationId: policy.shareReservationId, createdAt: this.clock(), published: false };
    this.tracks.set(this.key(policy.identity, intent.cid), lease);
    return { ...lease };
  }

  confirm(identity: string, cid: string, sid: string, source: MediaSource) {
    const lease = this.tracks.get(this.canonicalKey(identity, cid));
    if (!lease || !sid || lease.source !== source) throw new MediaPolicyError('unreserved_publication', 'An unreserved publication was returned by the media server.');
    if (lease.sid !== sid) delete lease.observed;
    lease.sid = sid;
    lease.published = true;
  }

  private matchingLease(candidate: TrackLease) {
    const current = this.tracks.get(this.canonicalKey(candidate.identity, candidate.cid));
    return current && current.published && current.sid === candidate.sid && current.source === candidate.source
      && current.reservationId === candidate.reservationId && current.createdAt === candidate.createdAt ? current : undefined;
  }

  observe(candidate: TrackLease, participantSid: string, version: number) {
    const current = this.matchingLease(candidate);
    if (!current || !participantSid) return;
    // A SID belongs to one participant generation. A later generation's actual
    // re-publication receives a new track SID and confirm() resets observation.
    if (current.observed && current.observed.participantSid !== participantSid) return;
    if (!current.observed || version > current.observed.version) current.observed = { participantSid, version };
  }

  canConfirmAbsence(candidate: TrackLease, participantSid: string, version: number) {
    const current = this.matchingLease(candidate);
    return !!current?.observed && current.observed.participantSid === participantSid && version > current.observed.version;
  }

  assertSync(identity: string, publications: Array<{ cid: string; sid: string; source: MediaSource }>) {
    for (const publication of publications) {
      const lease = this.tracks.get(this.canonicalKey(identity, publication.cid));
      if (!lease || !lease.published || lease.sid !== publication.sid || lease.source !== publication.source) {
        throw new MediaPolicyError('unknown_reconnect_track', 'A reconnect cannot introduce an unreserved track.');
      }
    }
  }

  /** Call only after the SFU confirms the track no longer exists, or emits its unpublish response. */
  removeSid(identity: string, sid: string) {
    for (const [key, track] of this.tracks) if (track.identity === identity && track.sid === sid) this.tracks.delete(key);
    this.pruneAliases();
  }

  /** Call only after a successful participant removal, or confirmed source-permission revocation. */
  removeSources(identity: string, allowed: MediaSource[]) {
    for (const [key, track] of this.tracks) if (track.identity === identity && !allowed.includes(track.source)) this.tracks.delete(key);
    this.pruneAliases();
  }

  removeIdentity(identity: string) { for (const [key, track] of this.tracks) if (track.identity === identity) this.tracks.delete(key); this.pruneAliases(); }
  removeRoom(roomName: string) { for (const [key, track] of this.tracks) if (track.roomName === roomName) this.tracks.delete(key); this.pruneAliases(); }
  pendingExpired(milliseconds: number) { return [...new Set([...this.tracks.values()].filter(track => !track.published && this.clock() - track.createdAt > milliseconds).map(track => track.identity))]; }
  snapshot() { return [...this.tracks.values()].map(track => ({ ...track })); }
}

export type RoomMode = 'stage' | 'open' | 'qa';
/** New rooms welcome conversation; members still turn on their own microphones. */
export const DEFAULT_ROOM_MODE: RoomMode = 'open';
export type MediaSource = 'microphone' | 'screen_share' | 'screen_share_audio';

/** Supplied only by authenticated server code, never copied from a request body. */
export interface Principal {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  isAdmin: boolean;
  isOwner: boolean;
  deviceId: string;
}

export interface Admission {
  id: string;
  identity: string;
  sessionId: string;
  roomName: string;
  userId: string;
  deviceId: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
  connected: boolean;
  revoked: boolean;
  revokeReason?: string;
}

export interface MediaPolicy {
  identity: string;
  accountId: string;
  userId: string;
  deviceId: string;
  admissionId: string;
  roomName: string;
  sessionId: string;
  displayName: string;
  active: boolean;
  allowedSources: MediaSource[];
  shareReservationId?: string;
  reason?: string;
}

export interface LiveSession {
  id: string;
  roomName: string;
  title: string;
  scheduleId: string | null;
  state: 'waiting' | 'live';
  mode: RoomMode;
  locked: boolean;
  openedAt: string;
  /** Set only after the admin starts the live session and media-policy synchronization completes. */
  startedAt: string | null;
  /** @deprecated Compatibility mirror of mode === 'open'; mode owns speaking eligibility in both phases. */
  waitingAudienceCanSpeak: boolean;
  audienceMuted: boolean;
  muteExceptUserId: string | null;
  spotlightReservationId: string | null;
}

export interface ScheduledSession {
  id: string;
  title: string;
  description: string;
  /** Initial speaking mode when an admin opens this scheduled waiting room. */
  mode: RoomMode;
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'cancelled' | 'completed';
  sessionId: string | null;
  createdBy: string;
}

export interface ParticipantView {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  isAdmin: boolean;
  isOwner: boolean;
  onStage: boolean;
  microphoneBlocked: boolean;
  canSpeak: boolean;
  hasHandRaised: boolean;
  microphoneDeviceId: string | null;
  connected: boolean;
  devices: Array<{ deviceId: string; identity: string; connected: boolean }>;
}

export interface ShareReservation {
  id: string;
  reservationId: string;
  sessionId: string;
  userId: string;
  deviceId: string;
  identity: string;
  displayName: string;
  status: 'reserved' | 'active';
  createdAt: string;
  expiresAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  displayName: string;
  avatarUrl?: string;
  text: string;
  mentions: Array<{ userId: string; displayName: string }>;
  createdAt: string;
  reactions: Record<string, string[]>;
  clientId?: string;
}

export interface PinnedMessage {
  messageId: string;
  pinnedByUserId: string;
  pinnedByName: string;
  pinnedAt: string;
}

export interface StageReaction {
  id: string;
  userId: string;
  displayName: string;
  emoji: string;
  createdAt: string;
  clientId?: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  targetId: string | null;
  sessionId: string | null;
  timestamp: string;
  outcome: 'success' | 'denied' | 'failed';
  /** IDs or error codes only; message bodies and credentials are never recorded. */
  detail?: string;
}

export interface PolicyDefaults {
  reconnectGraceSeconds: number;
  shareReservationSeconds: number;
  maxScreenShares: number;
  maxPins: number;
  maxMessageLength: number;
  chatMessagesPer10Seconds: number;
  reactionsPer10Seconds: number;
  auditRetentionDays: number;
  groupMuteSemantics: 'current-role';
  crossAdminRemoval: 'owner-only';
  kickScope: 'account';
  muteExceptScope: 'account';
}

export interface AdminConfiguration {
  ownerUserId: string;
  adminRoleIds: string[];
  explicitAdminUserIds: string[];
}

export interface RoomSnapshot {
  revision: number;
  serverTime: string;
  session: LiveSession | null;
  schedules: ScheduledSession[];
  participants: ParticipantView[];
  shares: ShareReservation[];
  messages: ChatMessage[];
  pins: PinnedMessage[];
  reactions: StageReaction[];
  handRequests: Array<{ userId: string; displayName: string; raisedAt: string }>;
  self: Principal & {
    admission: Admission | null;
    canSpeak: boolean;
    canShare: boolean;
    microphoneOwned: boolean;
    banned: boolean;
    sessionBlocked: boolean;
  };
  policy: PolicyDefaults;
  cleanupPending: boolean;
  mediaSyncPending: boolean;
  audit?: AuditEvent[];
  bans?: Array<{ userId: string; displayName: string }>;
  /** Admin-only restore targets, including members removed from the live list. */
  sessionBlocks?: Array<{ userId: string; displayName: string }>;
  adminConfiguration?: AdminConfiguration;
}

export type Command =
  | { type: 'session.open'; title?: string; scheduleId?: string; mode?: RoomMode }
  | { type: 'session.start' }
  | { type: 'session.end' }
  | { type: 'room.join' }
  | { type: 'room.leave' }
  | { type: 'room.lock'; locked: boolean }
  | { type: 'room.mode'; mode: RoomMode }
  | { type: 'room.waiting-audio'; enabled: boolean }
  | { type: 'schedule.save'; id?: string; title: string; description?: string; startsAt: string; endsAt: string; mode?: RoomMode }
  | { type: 'schedule.cancel'; id: string }
  | { type: 'member.stage'; userId: string; onStage: boolean }
  | { type: 'member.microphone'; userId: string; action: 'mute' | 'block' | 'allow' }
  | { type: 'group.microphone'; action: 'audience' | 'except-me' | 'allow' }
  | { type: 'member.remove'; userId: string; action: 'kick' | 'session-block' | 'ban' }
  | { type: 'member.restore'; userId: string }
  | { type: 'hand.set'; raised: boolean }
  | { type: 'hand.decline'; userId: string }
  | { type: 'mic.acquire' }
  | { type: 'mic.release' }
  | { type: 'share.reserve' }
  | { type: 'share.confirm'; reservationId: string }
  | { type: 'share.release' }
  | { type: 'share.stop'; userId: string }
  | { type: 'spotlight.set'; reservationId: string | null }
  | { type: 'chat.send'; text: string; mentionUserIds?: string[]; clientId?: string }
  | { type: 'chat.remove'; messageId: string }
  | { type: 'chat.pin'; messageId: string; pinned: boolean }
  | { type: 'chat.react'; messageId: string; emoji: string; clientId?: string }
  | { type: 'reaction.send'; emoji: string; clientId?: string }
  | { type: 'admin.assign'; userId: string; admin: boolean }
  | { type: 'admin.roles'; roleIds: string[] };

export interface CommandResult {
  ok: true;
  snapshot: RoomSnapshot;
  admission?: Admission;
  reservation?: ShareReservation;
}

export const REACTION_EMOJI = ['👍', '❤️', '🔥', '👏', '😂', '🎉'] as const;

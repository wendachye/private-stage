import { randomUUID } from 'node:crypto';
import { StageStore } from '../storage/stage-store.ts';
import { DEFAULT_ROOM_MODE, REACTION_EMOJI } from '../../../shared/types.ts';
import type {
  Admission, AdminConfiguration, AuditEvent, ChatMessage, Command, CommandResult, LiveSession,
  MediaPolicy, ParticipantView, PinnedMessage, PolicyDefaults, Principal, RoomMode, RoomSnapshot,
  ScheduledSession, ShareReservation, StageReaction,
} from '../../../shared/types.ts';

export class DomainError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = 'DomainError'; this.status = status; this.code = code;
  }
}

export interface MediaEffects {
  reconcile(roomName: string, policies: MediaPolicy[]): Promise<void>;
  remove(roomName: string, identity: string): Promise<void>;
  closeRoom(roomName: string): Promise<void>;
  mute(roomName: string, identity: string): Promise<void>;
}

interface KnownUser { userId: string; displayName: string; avatarUrl?: string; isAdmin: boolean; isOwner: boolean }
interface State {
  revision: number;
  live: LiveSession | null;
  schedules: ScheduledSession[];
  users: Record<string, KnownUser>;
  admissions: Admission[];
  stage: string[];
  microphoneBlocks: string[];
  microphoneOwners: Record<string, string>;
  hands: Record<string, string>;
  shares: ShareReservation[];
  stoppingShares: string[];
  messages: ChatMessage[];
  pins: PinnedMessage[];
  reactions: StageReaction[];
  bans: Record<string, string>;
  sessionBlocks: string[];
  adminConfiguration: AdminConfiguration;
  adminRolesConfigured?: boolean;
  cleanupRooms: string[];
  mediaSyncPending: boolean;
  reactionRequests?: Record<string, number>;
}

export interface StageOptions {
  databasePath: string;
  ownerUserId?: string;
  adminRoleIds?: string[];
  policy?: Partial<PolicyDefaults>;
  now?: () => number;
  media?: Partial<MediaEffects>;
  onChange?: () => void;
}

/** Approved moderation semantics plus explicit engineering numeric defaults, surfaced by every snapshot. */
export const DEFAULT_POLICY: PolicyDefaults = {
  reconnectGraceSeconds: 90, shareReservationSeconds: 30, maxScreenShares: 3, maxPins: 5,
  maxMessageLength: 2000, chatMessagesPer10Seconds: 5, reactionsPer10Seconds: 10,
  auditRetentionDays: 90, groupMuteSemantics: 'current-role', crossAdminRemoval: 'owner-only',
  kickScope: 'account', muteExceptScope: 'account',
};

const noMedia: MediaEffects = {
  async reconcile() {}, async remove() {}, async closeRoom() {}, async mute() {},
};

function fail(status: number, code: string, message: string): never { throw new DomainError(status, code, message); }
function text(value: unknown, name: string, max = 128, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, 'invalid_input', `${name} must contain ${min}-${max} characters.`);
  return value.trim();
}
function bool(value: unknown, name: string): boolean { if (typeof value !== 'boolean') fail(400, 'invalid_input', `${name} must be a boolean.`); return value; }
function readRoomMode(value: unknown): RoomMode {
  const mode = text(value, 'mode');
  if (!['stage', 'open', 'qa'].includes(mode)) fail(400, 'invalid_mode', 'Unknown room mode.');
  return mode as RoomMode;
}
function instant(value: unknown, name: string): string {
  const result = text(value, name, 60);
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(result) || !Number.isFinite(Date.parse(result))) fail(400, 'invalid_date', `${name} must be an ISO timestamp with an explicit timezone.`);
  return new Date(result).toISOString();
}

export class StageService {
  readonly store: StageStore;
  readonly policy: PolicyDefaults;
  private state: State;
  private now: () => number;
  private media: MediaEffects;
  private onChange: () => void;
  private tail: Promise<void> = Promise.resolve();
  private rates = new Map<string, number[]>();

  constructor(options: StageOptions) {
    this.now = options.now ?? Date.now;
    this.media = {
      reconcile: options.media?.reconcile?.bind(options.media) ?? noMedia.reconcile,
      remove: options.media?.remove?.bind(options.media) ?? noMedia.remove,
      closeRoom: options.media?.closeRoom?.bind(options.media) ?? noMedia.closeRoom,
      mute: options.media?.mute?.bind(options.media) ?? noMedia.mute,
    };
    this.onChange = options.onChange ?? (() => {});
    this.policy = { ...DEFAULT_POLICY, ...options.policy, maxScreenShares: 3 };
    this.store = new StageStore(options.databasePath);
    this.state = this.store.read<State>() ?? {
      revision: 0, live: null, schedules: [], users: {}, admissions: [], stage: [], microphoneBlocks: [],
      microphoneOwners: {}, hands: {}, shares: [], stoppingShares: [], messages: [], pins: [], reactions: [],
      bans: {}, sessionBlocks: [], adminConfiguration: { ownerUserId: options.ownerUserId ?? '', adminRoleIds: options.adminRoleIds ?? [], explicitAdminUserIds: [] }, adminRolesConfigured: false, cleanupRooms: [], mediaSyncPending: false,
    };
    // Owner identity is environment-controlled; persisted settings cannot replace it.
    if (options.ownerUserId) this.state.adminConfiguration.ownerUserId = options.ownerUserId;
    // Until the owner saves an explicit override, environment roles remain the initial setup source.
    // Old local-preview states have no marker and therefore migrate to this seed behavior.
    this.state.adminRolesConfigured ??= false;
    this.state.mediaSyncPending ??= false;
    // Schedules are stored inside the durable state document. Older schedules
    // predate a chosen speaking mode; retain their data and apply the new-room default.
    for (const schedule of this.state.schedules) if (!['stage', 'open', 'qa'].includes(schedule.mode)) schedule.mode = DEFAULT_ROOM_MODE;
    if (!this.state.adminRolesConfigured && options.adminRoleIds !== undefined) this.state.adminConfiguration.adminRoleIds = [...new Set(options.adminRoleIds)];
    if (this.state.live) {
      const prior = this.state.live;
      // Older persisted live sessions predate the explicit waiting phase. Normalize
      // their metadata before the existing restart-close path; never resume them.
      prior.state ??= 'live';
      prior.startedAt ??= prior.state === 'live' ? prior.openedAt : null;
      prior.waitingAudienceCanSpeak = prior.mode === 'open';
      this.state.cleanupRooms = [...new Set([...this.state.cleanupRooms, prior.roomName])];
      this.state.mediaSyncPending = true;
      this.endState();
      this.save(this.event({ userId: 'system', displayName: 'System', deviceId: 'system', isAdmin: false, isOwner: false }, 'session.restart-close', null, 'success', undefined, prior.id));
    } else this.save();
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
  private admin(actor: Principal): boolean { return actor.isAdmin || actor.isOwner || (!!this.state.adminConfiguration.ownerUserId && actor.userId === this.state.adminConfiguration.ownerUserId); }
  private owner(actor: Principal): boolean { return this.state.adminConfiguration.ownerUserId ? actor.userId === this.state.adminConfiguration.ownerUserId : actor.isOwner; }
  private requireAdmin(actor: Principal): void { if (!this.admin(actor)) fail(403, 'admin_required', 'Only an authorized admin can perform this action.'); }
  private requireOwner(actor: Principal): void { if (!this.owner(actor)) fail(403, 'owner_required', 'Only the owner can manage app-admin assignments.'); }
  private live(): LiveSession { if (!this.state.live) fail(409, 'room_closed', 'The room is closed. An admin must open a session.'); return this.state.live; }
  private user(userId: string): KnownUser { return this.state.users[userId] ?? { userId, displayName: userId, isAdmin: this.state.adminConfiguration.explicitAdminUserIds.includes(userId), isOwner: userId === this.state.adminConfiguration.ownerUserId }; }
  private remember(actor: Principal): void {
    this.state.users[actor.userId] = { userId: actor.userId, displayName: actor.displayName, avatarUrl: actor.avatarUrl, isAdmin: this.admin(actor), isOwner: this.owner(actor) };
  }
  private event(actor: Principal, action: string, targetId: string | null, outcome: AuditEvent['outcome'], detail?: string, sessionId = this.state.live?.id ?? null): AuditEvent {
    return { id: randomUUID(), actorId: actor.userId, actorName: actor.displayName, action, targetId, sessionId, timestamp: this.iso(), outcome, ...(detail ? { detail } : {}) };
  }
  private save(event?: AuditEvent): void {
    this.state.revision++;
    this.store.save(this.state, event ? [event] : [], new Date(this.now() - this.policy.auditRetentionDays * 86400000).toISOString());
    this.onChange();
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => {}, () => {});
    return run;
  }
  private admitted(actor: Principal): Admission {
    const session = this.live();
    if (this.state.bans[actor.userId] || this.state.sessionBlocks.includes(actor.userId)) fail(403, 'entry_blocked', 'This account is restricted from the room.');
    const admission = this.state.admissions.find(a => !a.revoked && a.sessionId === session.id && a.userId === actor.userId && a.deviceId === actor.deviceId);
    if (!admission) fail(403, 'admission_required', 'Join the active session before using its content.');
    return admission;
  }
  private canSpeak(userId: string): boolean {
    const room = this.state.live;
    if (!room || this.state.bans[userId] || this.state.sessionBlocks.includes(userId) || this.state.microphoneBlocks.includes(userId)) return false;
    if (room.muteExceptUserId && room.muteExceptUserId !== userId) return false;
    const onStage = this.state.stage.includes(userId);
    if (room.audienceMuted && !onStage) return false;
    return onStage || room.mode === 'open';
  }
  private target(actor: Principal, value: unknown, protectStage = false): string {
    this.requireAdmin(actor);
    const id = text(value, 'userId');
    if (protectStage && this.user(id).isOwner && actor.userId !== id) fail(403, 'owner_protected', 'Another admin cannot remove or demote the owner.');
    return id;
  }
  private rate(actor: Principal, kind: 'chat' | 'reaction'): void {
    const key = `${this.live().id}:${actor.userId}:${kind}`;
    const recent = (this.rates.get(key) ?? []).filter(time => time > this.now() - 10000);
    const max = kind === 'chat' ? this.policy.chatMessagesPer10Seconds : this.policy.reactionsPer10Seconds;
    if (recent.length >= max) fail(429, 'rate_limited', 'Please wait a moment before sending again.');
    recent.push(this.now()); this.rates.set(key, recent);
  }
  private endState(): void {
    const prior = this.state.live;
    if (prior?.scheduleId) {
      const schedule = this.state.schedules.find(item => item.id === prior.scheduleId);
      if (schedule) schedule.status = 'completed';
    }
    for (const admission of this.state.admissions) if (!admission.revoked) { admission.revoked = true; admission.revokeReason = 'session-ended'; admission.connected = false; }
    this.state.live = null;
    this.state.stage = []; this.state.microphoneBlocks = []; this.state.microphoneOwners = {}; this.state.hands = {};
    this.state.shares = []; this.state.stoppingShares = []; this.state.messages = []; this.state.pins = []; this.state.reactions = []; this.state.sessionBlocks = [];
    this.state.reactionRequests = {};
    this.rates.clear();
  }

  getAdminConfiguration(): AdminConfiguration { return structuredClone(this.state.adminConfiguration); }
  hasCleanupPending(): boolean { return this.state.cleanupRooms.length > 0; }
  /** Server-only input: synchronize flags obtained from a fresh authoritative identity check. */
  async refreshPrincipal(actor: Principal): Promise<void> {
    await this.serialized(async () => { this.remember(actor); this.save(); });
  }
  getAdmission(identityOrId: string): Admission | null { return structuredClone(this.state.admissions.find(item => item.identity === identityOrId || item.id === identityOrId) ?? null); }
  listAdmissions(): Admission[] { return structuredClone(this.state.admissions); }
  mediaPolicy(identity: string): MediaPolicy | null {
    const admission = this.state.admissions.find(item => item.identity === identity);
    if (!admission) return null;
    const room = this.state.live;
    const reconnectExpired = !!room?.locked && !admission.connected && this.now() - Date.parse(admission.disconnectedAt ?? admission.lastSeenAt) > this.policy.reconnectGraceSeconds * 1000;
    const active = !!room && admission.sessionId === room.id && !admission.revoked && !this.state.bans[admission.userId] && !this.state.sessionBlocks.includes(admission.userId) && !this.state.cleanupRooms.length && !reconnectExpired;
    const allowedSources: MediaPolicy['allowedSources'] = [];
    let shareReservationId: string | undefined;
    if (active) {
      if (this.canSpeak(admission.userId) && this.state.microphoneOwners[admission.userId] === admission.deviceId) allowedSources.push('microphone');
      const lease = this.state.shares.find(item => item.identity === identity && !this.state.stoppingShares.includes(item.id) && (item.status === 'active' || Date.parse(item.expiresAt) > this.now()));
      if (lease && this.state.stage.includes(admission.userId)) { allowedSources.push('screen_share', 'screen_share_audio'); shareReservationId = lease.id; }
    }
    return { identity, accountId: admission.userId, userId: admission.userId, deviceId: admission.deviceId, admissionId: admission.id, roomName: admission.roomName, sessionId: admission.sessionId, displayName: admission.displayName, active, allowedSources, ...(shareReservationId ? { shareReservationId } : {}), ...(!active ? { reason: admission.revokeReason ?? 'session-or-admission-closed' } : {}) };
  }
  listMediaPolicies(roomName?: string): MediaPolicy[] {
    return this.state.admissions.filter(item => !roomName || item.roomName === roomName).map(item => this.mediaPolicy(item.identity)!).filter(Boolean);
  }
  private async reconcile(roomName = this.state.live?.roomName): Promise<void> {
    if (!roomName) return;
    // Save the desired policy and its retry obligation before contacting the SFU. All domain
    // mutations are serialized, so a successful reconcile confirms this exact policy revision.
    this.state.mediaSyncPending = true;
    this.save();
    await this.media.reconcile(roomName, this.listMediaPolicies(roomName));
    this.state.mediaSyncPending = false;
    this.save();
  }
  private async stopShares(predicate: (share: ShareReservation) => boolean): Promise<void> {
    const selected = this.state.shares.filter(predicate);
    if (!selected.length) return;
    for (const share of selected) if (!this.state.stoppingShares.includes(share.id)) this.state.stoppingShares.push(share.id);
    this.save(); // deny first; a failed media revoke retains occupied, stopping slots.
    await this.reconcile();
    const ids = new Set(selected.map(item => item.id));
    this.state.shares = this.state.shares.filter(item => !ids.has(item.id));
    this.state.stoppingShares = this.state.stoppingShares.filter(id => !ids.has(id));
    if (this.state.live?.spotlightReservationId && ids.has(this.state.live.spotlightReservationId)) this.state.live.spotlightReservationId = null;
    this.save();
  }
  private async cleanReservations(): Promise<void> {
    await this.stopShares(share => this.state.stoppingShares.includes(share.id) || (share.status === 'reserved' && Date.parse(share.expiresAt) <= this.now()));
  }

  snapshot(actor: Principal): RoomSnapshot {
    const room = this.state.live;
    const admission = room ? this.state.admissions.find(a => !a.revoked && a.sessionId === room.id && a.userId === actor.userId && a.deviceId === actor.deviceId) ?? null : null;
    const allowed = !!admission && !this.state.bans[actor.userId] && !this.state.sessionBlocks.includes(actor.userId);
    const visible = !!room && allowed;
    const currentAdmissions = this.state.admissions.filter(item => !item.revoked && item.sessionId === room?.id);
    const participants: ParticipantView[] = visible ? [...new Set(currentAdmissions.map(a => a.userId))].map(userId => {
      const user = this.user(userId); const devices = currentAdmissions.filter(a => a.userId === userId);
      return { ...user, onStage: this.state.stage.includes(userId), microphoneBlocked: this.state.microphoneBlocks.includes(userId), canSpeak: this.canSpeak(userId), hasHandRaised: !!this.state.hands[userId], microphoneDeviceId: this.state.microphoneOwners[userId] ?? null, connected: devices.some(a => a.connected), devices: devices.map(a => ({ deviceId: a.deviceId, identity: a.identity, connected: a.connected })) };
    }) : [];
    return structuredClone({
      revision: this.state.revision, serverTime: this.iso(), session: room,
      schedules: [...this.state.schedules].sort((a,b) => a.startsAt.localeCompare(b.startsAt)), participants,
      shares: visible ? this.state.shares.filter(share => !this.state.stoppingShares.includes(share.id)) : [],
      messages: visible ? this.state.messages : [], pins: visible ? this.state.pins : [],
      reactions: visible ? this.state.reactions.filter(item => Date.parse(item.createdAt) > this.now() - 10000) : [],
      handRequests: visible ? Object.entries(this.state.hands).map(([userId, raisedAt]) => ({ userId, displayName: this.user(userId).displayName, raisedAt })).sort((a,b) => a.raisedAt.localeCompare(b.raisedAt)) : [],
      self: { ...actor, admission: allowed ? admission : null, canSpeak: allowed && this.canSpeak(actor.userId), canShare: allowed && this.state.stage.includes(actor.userId), microphoneOwned: allowed && this.state.microphoneOwners[actor.userId] === actor.deviceId, banned: !!this.state.bans[actor.userId], sessionBlocked: this.state.sessionBlocks.includes(actor.userId) },
      policy: this.policy, cleanupPending: this.state.cleanupRooms.length > 0, mediaSyncPending: this.state.mediaSyncPending,
      ...(this.admin(actor) ? { audit: this.store.audit(), bans: Object.entries(this.state.bans).map(([userId, displayName]) => ({ userId, displayName })), sessionBlocks: this.state.sessionBlocks.map(userId => ({ userId, displayName: this.user(userId).displayName })) } : {}),
      ...(this.owner(actor) ? { adminConfiguration: this.state.adminConfiguration } : {}),
    });
  }

  async startupClose(): Promise<void> {
    await this.serialized(async () => {
      for (const roomName of [...this.state.cleanupRooms]) {
        await this.media.closeRoom(roomName);
        this.state.cleanupRooms = this.state.cleanupRooms.filter(name => name !== roomName);
        if (!this.state.cleanupRooms.length && !this.state.live) this.state.mediaSyncPending = false;
        this.save();
      }
      this.store.checkpoint();
    });
  }

  async admit(actor: Principal): Promise<Admission> {
    const result = await this.execute(actor, { type: 'room.join' });
    return result.admission!;
  }

  async setConnection(identity: string, connected: boolean): Promise<void> {
    await this.serialized(async () => {
      const admission = this.state.admissions.find(item => item.identity === identity);
      if (!admission || admission.revoked) return;
      admission.connected = connected; admission.lastSeenAt = this.iso(); admission.disconnectedAt = connected ? null : this.iso();
      if (!connected) {
        if (this.state.microphoneOwners[admission.userId] === admission.deviceId) delete this.state.microphoneOwners[admission.userId];
        this.save();
        await this.stopShares(item => item.identity === identity);
        await this.reconcile();
      }
      this.save();
    });
  }

  async invalidateAccount(userId: string, reason: string): Promise<void> {
    await this.serialized(async () => {
      const admissions = this.state.admissions.filter(item => item.userId === userId && !item.revoked);
      for (const admission of admissions) { admission.revoked = true; admission.revokeReason = reason; admission.connected = false; }
      delete this.state.microphoneOwners[userId]; delete this.state.hands[userId]; this.state.stage = this.state.stage.filter(id => id !== userId);
      if (admissions.length) this.state.mediaSyncPending = true;
      this.save();
      await this.stopShares(item => item.userId === userId);
      if (admissions.length) { this.state.mediaSyncPending = true; this.save(); }
      for (const admission of admissions) await this.media.remove(admission.roomName, admission.identity);
      await this.reconcile();
    });
  }

  async prune(): Promise<void> {
    await this.serialized(async () => {
      await this.cleanReservations();
      if (this.state.mediaSyncPending && this.state.live) await this.reconcile();
    });
  }

  /** Trusted SFU notification; no browser-supplied source/identity is accepted by this entry point. */
  async releaseShareByIdentity(identity: string, expectedReservationId?: string): Promise<void> {
    await this.serialized(async () => { await this.stopShares(share => share.identity === identity && (expectedReservationId === undefined || share.id === expectedReservationId)); });
  }

  async execute(actor: Principal, raw: unknown): Promise<CommandResult> {
    return this.serialized(async () => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'invalid_command', 'A command object is required.');
      const command = raw as Record<string, unknown>;
      const type = text(command.type, 'type');
      this.remember(actor);
      const administrative = /^(session\.|schedule\.|member\.|group\.|room\.(?:lock|mode|waiting-audio)|hand\.decline|spotlight\.|share\.stop|chat\.(?:remove|pin)|admin\.)/.test(type);
      let targetId: string | null = typeof command.userId === 'string' ? command.userId : typeof command.messageId === 'string' ? command.messageId : null;
      const sessionId = this.state.live?.id ?? null;
      let admission: Admission | undefined; let reservation: ShareReservation | undefined;
      try {
        if (type !== 'session.end') await this.cleanReservations();
        switch (type) {
          case 'session.open': {
            this.requireAdmin(actor);
            if (this.state.cleanupRooms.length) fail(503, 'cleanup_pending', 'Previous media cleanup must finish before opening a session.');
            if (this.state.live) fail(409, 'already_live', 'A session is already open.');
            if (this.state.bans[actor.userId] || this.state.sessionBlocks.includes(actor.userId)) fail(403, 'entry_blocked', 'This account cannot open and join the room while its access is restricted.');
            const scheduleId = command.scheduleId === undefined ? null : text(command.scheduleId, 'scheduleId');
            const schedule = scheduleId ? this.state.schedules.find(item => item.id === scheduleId) : undefined;
            if (scheduleId && (!schedule || schedule.status !== 'scheduled' || schedule.sessionId)) fail(409, 'schedule_unavailable', 'This reservation cannot be opened. Create a new session.');
            const mode = command.mode === undefined ? schedule?.mode ?? DEFAULT_ROOM_MODE : readRoomMode(command.mode);
            const id = randomUUID();
            this.state.live = { id, roomName: `private-stage-${id}`, title: schedule?.title ?? (command.title === undefined ? 'Private Stage' : text(command.title, 'title', 100)), scheduleId, state: 'waiting', mode, locked: false, openedAt: this.iso(), startedAt: null, waitingAudienceCanSpeak: mode === 'open', audienceMuted: false, muteExceptUserId: null, spotlightReservationId: null };
            // The opener is admitted and placed on stage atomically with creation.
            // Admission grants no microphone ownership: the device still connects
            // media separately and only its user can explicitly enable its mic.
            const admissionId = randomUUID();
            admission = { id: admissionId, identity: `u_${actor.userId}:d_${actor.deviceId}:a_${admissionId}`, sessionId: id, roomName: this.state.live.roomName, userId: actor.userId, deviceId: actor.deviceId, displayName: actor.displayName, createdAt: this.iso(), lastSeenAt: this.iso(), disconnectedAt: null, connected: false, revoked: false };
            this.state.admissions.push(admission);
            if (!this.state.stage.includes(actor.userId)) this.state.stage.push(actor.userId);
            if (schedule) schedule.sessionId = id;
            break;
          }
          case 'session.start': {
            this.requireAdmin(actor);
            const room = this.live();
            if (room.state !== 'waiting') fail(409, 'already_live', 'This session is already live.');
            room.waitingAudienceCanSpeak = room.mode === 'open';
            for (const id of Object.keys(this.state.microphoneOwners)) if (!this.canSpeak(id)) delete this.state.microphoneOwners[id];
            // Starting preserves the selected speaking mode and eligible microphone
            // ownership. Confirm its current media policy before announcing Live.
            this.save(); await this.reconcile();
            room.state = 'live';
            room.startedAt = this.iso();
            break;
          }
          case 'session.end': {
            this.requireAdmin(actor);
            const prior = this.state.live;
            if (prior) {
              this.state.cleanupRooms = [...new Set([...this.state.cleanupRooms, prior.roomName])];
              this.state.mediaSyncPending = true;
              this.endState(); this.save();
            }
            for (const roomName of [...this.state.cleanupRooms]) {
              await this.media.closeRoom(roomName);
              this.state.cleanupRooms = this.state.cleanupRooms.filter(name => name !== roomName);
              if (!this.state.cleanupRooms.length) this.state.mediaSyncPending = false;
              this.save();
            }
            this.store.checkpoint(); break;
          }
          case 'room.join': {
            const room = this.live();
            if (this.state.cleanupRooms.length) fail(503, 'cleanup_pending', 'Media cleanup is still pending.');
            if (this.state.bans[actor.userId] || this.state.sessionBlocks.includes(actor.userId)) fail(403, 'entry_blocked', 'This account cannot join the room.');
            const prior = this.state.admissions.find(item => !item.revoked && item.sessionId === room.id && item.userId === actor.userId && item.deviceId === actor.deviceId);
            const graceValid = prior && (prior.connected || this.now() - Date.parse(prior.disconnectedAt ?? prior.lastSeenAt) <= this.policy.reconnectGraceSeconds * 1000);
            if (room.locked && !this.admin(actor) && !graceValid) fail(403, 'room_locked', 'The room is locked to new admissions.');
            if (prior && graceValid) { admission = prior; admission.lastSeenAt = this.iso(); }
            else {
              if (prior) { prior.revoked = true; prior.revokeReason = 'admission-replaced'; }
              const id = randomUUID();
              admission = { id, identity: `u_${actor.userId}:d_${actor.deviceId}:a_${id}`, sessionId: room.id, roomName: room.roomName, userId: actor.userId, deviceId: actor.deviceId, displayName: actor.displayName, createdAt: this.iso(), lastSeenAt: this.iso(), disconnectedAt: null, connected: false, revoked: false };
              this.state.admissions.push(admission);
            }
            break;
          }
          case 'room.leave': {
            const own = this.admitted(actor); own.revoked = true; own.revokeReason = 'left'; own.connected = false;
            if (this.state.microphoneOwners[actor.userId] === actor.deviceId) delete this.state.microphoneOwners[actor.userId];
            // A hand belongs to the account while any of its devices remains
            // admitted. An explicit final leave must not strand it in the queue.
            if (!this.state.admissions.some(item => !item.revoked && item.sessionId === own.sessionId && item.userId === actor.userId)) delete this.state.hands[actor.userId];
            this.state.mediaSyncPending = true;
            this.save(); await this.stopShares(item => item.identity === own.identity);
            this.state.mediaSyncPending = true; this.save();
            await this.media.remove(own.roomName, own.identity); await this.reconcile(); break;
          }
          case 'room.lock': this.requireAdmin(actor); this.live().locked = bool(command.locked, 'locked'); break;
          case 'room.mode': {
            this.requireAdmin(actor); const mode = readRoomMode(command.mode);
            const room = this.live();
            room.mode = mode;
            room.waitingAudienceCanSpeak = mode === 'open';
            for (const id of Object.keys(this.state.microphoneOwners)) if (!this.canSpeak(id)) delete this.state.microphoneOwners[id];
            this.save(); await this.reconcile(); break;
          }
          case 'room.waiting-audio': {
            this.requireAdmin(actor); const room = this.live();
            if (room.state !== 'waiting') fail(409, 'waiting_room_required', 'Audience conversation can only be changed while the room is waiting.');
            // Older clients use the waiting-only toggle; keep it as a mode alias.
            room.mode = bool(command.enabled, 'enabled') ? 'open' : 'stage';
            room.waitingAudienceCanSpeak = room.mode === 'open';
            for (const id of Object.keys(this.state.microphoneOwners)) if (!this.canSpeak(id)) delete this.state.microphoneOwners[id];
            this.save(); await this.reconcile(); break;
          }
          case 'schedule.save': {
            this.requireAdmin(actor);
            const id = command.id === undefined ? randomUUID() : text(command.id, 'id'); targetId = id;
            const existing = this.state.schedules.find(item => item.id === id);
            if (command.id && !existing) fail(404, 'schedule_missing', 'Schedule not found.');
            if (existing && existing.status !== 'scheduled') fail(409, 'schedule_terminal', 'Cancelled or completed reservations cannot be reused.');
            const mode = command.mode === undefined ? existing?.mode ?? DEFAULT_ROOM_MODE : readRoomMode(command.mode);
            const startsAt = instant(command.startsAt, 'startsAt'), endsAt = instant(command.endsAt, 'endsAt');
            if (Date.parse(endsAt) <= Date.parse(startsAt)) fail(400, 'invalid_date', 'Expected end must follow the start.');
            if (this.state.schedules.some(item => item.id !== id && item.status === 'scheduled' && item.startsAt < endsAt && item.endsAt > startsAt)) fail(409, 'schedule_overlap', 'This reservation overlaps another session.');
            const schedule: ScheduledSession = { id, title: text(command.title, 'title', 100), description: command.description === undefined || command.description === '' ? '' : text(command.description, 'description', 1000), mode, startsAt, endsAt, status: 'scheduled', sessionId: existing?.sessionId ?? null, createdBy: existing?.createdBy ?? actor.userId };
            this.state.schedules = this.state.schedules.filter(item => item.id !== id); this.state.schedules.push(schedule); break;
          }
          case 'schedule.cancel': {
            this.requireAdmin(actor); const id = text(command.id, 'id'); targetId = id;
            const schedule = this.state.schedules.find(item => item.id === id);
            if (!schedule) fail(404, 'schedule_missing', 'Schedule not found.');
            if (schedule.sessionId === this.state.live?.id) fail(409, 'session_live', 'Explicitly end the live session before cancelling its reservation.');
            if (schedule.status === 'completed') fail(409, 'schedule_terminal', 'The reservation is already completed.');
            schedule.status = 'cancelled'; break;
          }
          case 'member.stage': {
            const id = this.target(actor, command.userId, !command.onStage); this.live();
            const onStage = bool(command.onStage, 'onStage');
            if (!this.state.admissions.some(a => a.userId === id && !a.revoked && a.sessionId === this.state.live?.id)) fail(404, 'participant_missing', 'That participant is not admitted.');
            this.state.stage = this.state.stage.filter(item => item !== id);
            if (onStage) this.state.stage.push(id);
            else { if (!this.canSpeak(id)) delete this.state.microphoneOwners[id]; this.save(); await this.stopShares(item => item.userId === id); }
            delete this.state.hands[id]; this.save(); await this.reconcile(); break;
          }
          case 'member.microphone': {
            const id = this.target(actor, command.userId); const action = text(command.action, 'action'); this.live();
            if (!['mute','block','allow'].includes(action)) fail(400, 'invalid_action', 'Unknown microphone action.');
            if (action === 'block') { if (!this.state.microphoneBlocks.includes(id)) this.state.microphoneBlocks.push(id); delete this.state.microphoneOwners[id]; this.save(); await this.reconcile(); }
            else if (action === 'allow') this.state.microphoneBlocks = this.state.microphoneBlocks.filter(item => item !== id);
            else for (const item of this.state.admissions.filter(a => a.userId === id && !a.revoked && a.sessionId === this.state.live?.id)) await this.media.mute(item.roomName, item.identity);
            break;
          }
          case 'group.microphone': {
            this.requireAdmin(actor); const room = this.live(); const action = text(command.action, 'action');
            if (action === 'audience') room.audienceMuted = true;
            else if (action === 'except-me') room.muteExceptUserId = actor.userId;
            else if (action === 'allow') { room.audienceMuted = false; room.muteExceptUserId = null; }
            else fail(400, 'invalid_action', 'Unknown group microphone action.');
            for (const id of Object.keys(this.state.microphoneOwners)) if (!this.canSpeak(id)) delete this.state.microphoneOwners[id];
            this.save(); await this.reconcile(); break;
          }
          case 'member.remove': {
            const id = this.target(actor, command.userId, true); this.live();
            if (this.user(id).isAdmin && !this.owner(actor) && actor.userId !== id) fail(403, 'owner_required', 'Only the owner can remove another app admin.');
            const action = text(command.action, 'action');
            if (!['kick','session-block','ban'].includes(action)) fail(400, 'invalid_action', 'Unknown removal action.');
            if (action === 'session-block' && !this.state.sessionBlocks.includes(id)) this.state.sessionBlocks.push(id);
            if (action === 'ban') this.state.bans[id] = this.user(id).displayName;
            const removed = this.state.admissions.filter(item => item.userId === id && !item.revoked && item.sessionId === this.state.live?.id);
            for (const item of removed) { item.revoked = true; item.revokeReason = action; item.connected = false; }
            this.state.stage = this.state.stage.filter(item => item !== id); delete this.state.microphoneOwners[id]; delete this.state.hands[id];
            if (removed.length) this.state.mediaSyncPending = true;
            this.save(); await this.stopShares(item => item.userId === id);
            if (removed.length) { this.state.mediaSyncPending = true; this.save(); }
            for (const item of removed) await this.media.remove(item.roomName, item.identity);
            await this.reconcile(); break;
          }
          case 'member.restore': {
            const id = this.target(actor, command.userId);
            if (this.user(id).isAdmin && !this.owner(actor) && actor.userId !== id) fail(403, 'owner_required', 'Only the owner can restore another app admin.');
            delete this.state.bans[id]; this.state.sessionBlocks = this.state.sessionBlocks.filter(item => item !== id); break;
          }
          case 'hand.set': this.admitted(actor); if (bool(command.raised, 'raised')) this.state.hands[actor.userId] = this.state.hands[actor.userId] ?? this.iso(); else delete this.state.hands[actor.userId]; break;
          case 'hand.decline': this.requireAdmin(actor); delete this.state.hands[text(command.userId, 'userId')]; break;
          case 'mic.acquire': {
            const own = this.admitted(actor);
            if (!this.canSpeak(actor.userId)) fail(403, 'microphone_blocked', 'Microphone publishing is not currently permitted.');
            delete this.state.microphoneOwners[actor.userId]; this.save();
            await this.reconcile(); // previous publisher must be denied before the next device is enabled.
            this.state.microphoneOwners[actor.userId] = own.deviceId; this.save(); await this.reconcile(); break;
          }
          case 'mic.release': {
            this.admitted(actor);
            if (this.state.microphoneOwners[actor.userId] === actor.deviceId) { delete this.state.microphoneOwners[actor.userId]; this.save(); await this.reconcile(); }
            break;
          }
          case 'share.reserve': {
            const own = this.admitted(actor);
            if (!this.state.stage.includes(actor.userId)) fail(403, 'stage_required', 'Only approved stage participants may share a screen.');
            const existing = this.state.shares.find(item => item.userId === actor.userId);
            if (existing) { if (existing.deviceId === actor.deviceId && !this.state.stoppingShares.includes(existing.id)) { reservation = existing; break; } fail(409, 'account_already_sharing', 'This account already holds a screen slot on another device.'); }
            if (this.state.shares.length >= this.policy.maxScreenShares) fail(409, 'screen_slots_full', 'All three screen-sharing slots are reserved.');
            const id = randomUUID(); reservation = { id, reservationId: id, sessionId: own.sessionId, userId: actor.userId, deviceId: actor.deviceId, identity: own.identity, displayName: actor.displayName, status: 'reserved', createdAt: this.iso(), expiresAt: new Date(this.now() + this.policy.shareReservationSeconds * 1000).toISOString() };
            this.state.shares.push(reservation); this.save(); await this.reconcile(); break;
          }
          case 'share.confirm': {
            this.admitted(actor); const id = text(command.reservationId, 'reservationId');
            reservation = this.state.shares.find(item => item.id === id && item.userId === actor.userId && item.deviceId === actor.deviceId && !this.state.stoppingShares.includes(item.id));
            if (!reservation) fail(409, 'reservation_expired', 'The screen reservation expired or was cancelled.');
            reservation.status = 'active'; break;
          }
          case 'share.release': this.admitted(actor); await this.stopShares(item => item.userId === actor.userId && item.deviceId === actor.deviceId); break;
          case 'share.stop': { const id = this.target(actor, command.userId); this.live(); await this.stopShares(item => item.userId === id); break; }
          case 'spotlight.set': {
            this.requireAdmin(actor); const room = this.live();
            const id = command.reservationId === null ? null : text(command.reservationId, 'reservationId');
            if (id && !this.state.shares.some(item => item.id === id && item.status === 'active' && !this.state.stoppingShares.includes(item.id))) fail(404, 'share_missing', 'That active share is no longer available.');
            room.spotlightReservationId = id; targetId = id; break;
          }
          case 'chat.send': {
            const own = this.admitted(actor);
            const clientId = command.clientId === undefined ? undefined : text(command.clientId, 'clientId');
            if (clientId && this.state.messages.some(item => item.userId === actor.userId && item.clientId === clientId)) break;
            const content = text(command.text, 'text', this.policy.maxMessageLength);
            const mentionsInput = command.mentionUserIds ?? [];
            if (!Array.isArray(mentionsInput) || mentionsInput.length > 10) fail(400, 'invalid_mentions', 'At most ten participant mentions are allowed.');
            const ids = [...new Set(mentionsInput.map(id => text(id, 'mention userId')))];
            if (ids.some(id => !this.state.admissions.some(a => !a.revoked && a.sessionId === own.sessionId && a.userId === id))) fail(400, 'invalid_mentions', 'Mentions must identify current authorized participants.');
            this.rate(actor, 'chat');
            this.state.messages.push({ id: randomUUID(), sessionId: own.sessionId, userId: actor.userId, displayName: actor.displayName, avatarUrl: actor.avatarUrl, text: content, mentions: ids.map(userId => ({ userId, displayName: this.user(userId).displayName })), createdAt: this.iso(), reactions: {}, ...(clientId ? { clientId } : {}) });
            // Bound a live session's retained content without retaining a permanent chat archive.
            if (this.state.messages.length > 1000) {
              const pinned = new Set(this.state.pins.map(pin => pin.messageId));
              const removable = this.state.messages.findIndex(item => !pinned.has(item.id));
              if (removable >= 0) this.state.messages.splice(removable, 1);
            }
            break;
          }
          case 'chat.remove': {
            this.requireAdmin(actor); this.live(); const id = text(command.messageId, 'messageId');
            if (!this.state.messages.some(item => item.id === id)) fail(404, 'message_missing', 'Message not found.');
            this.state.messages = this.state.messages.filter(item => item.id !== id); this.state.pins = this.state.pins.filter(item => item.messageId !== id); break;
          }
          case 'chat.pin': {
            this.requireAdmin(actor); this.live(); const id = text(command.messageId, 'messageId'); const pinned = bool(command.pinned, 'pinned');
            if (!this.state.messages.some(item => item.id === id)) fail(404, 'message_missing', 'Message not found.');
            const exists = this.state.pins.some(item => item.messageId === id);
            if (pinned && !exists) {
              if (this.state.pins.length >= this.policy.maxPins) fail(409, 'pin_limit', 'The session has reached its pin limit.');
              this.state.pins.push({ messageId: id, pinnedByUserId: actor.userId, pinnedByName: actor.displayName, pinnedAt: this.iso() });
            } else if (!pinned) this.state.pins = this.state.pins.filter(item => item.messageId !== id);
            break;
          }
          case 'chat.react': {
            this.admitted(actor); const id = text(command.messageId, 'messageId'); const emoji = text(command.emoji, 'emoji', 20);
            const clientId = command.clientId === undefined ? undefined : text(command.clientId, 'clientId');
            const requestKey = clientId ? `${this.live().id}:${actor.userId}:${clientId}` : null;
            this.state.reactionRequests ??= {};
            for (const [key, at] of Object.entries(this.state.reactionRequests)) if (at < this.now() - 60000) delete this.state.reactionRequests[key];
            if (requestKey && this.state.reactionRequests[requestKey] !== undefined) break;
            if (!(REACTION_EMOJI as readonly string[]).includes(emoji)) fail(400, 'invalid_reaction', 'Choose an available reaction.');
            const message = this.state.messages.find(item => item.id === id);
            if (!message) fail(404, 'message_missing', 'Message not found.');
            this.rate(actor, 'reaction'); const users = message.reactions[emoji] ?? [];
            const next = users.includes(actor.userId) ? users.filter(id => id !== actor.userId) : [...users, actor.userId];
            if (next.length) message.reactions[emoji] = next; else delete message.reactions[emoji];
            if (requestKey) this.state.reactionRequests[requestKey] = this.now(); break;
          }
          case 'reaction.send': {
            this.admitted(actor); const emoji = text(command.emoji, 'emoji', 20); const clientId = command.clientId === undefined ? undefined : text(command.clientId, 'clientId');
            if (!(REACTION_EMOJI as readonly string[]).includes(emoji)) fail(400, 'invalid_reaction', 'Choose an available reaction.');
            if (clientId && this.state.reactions.some(item => item.userId === actor.userId && item.clientId === clientId)) break;
            this.rate(actor, 'reaction'); this.state.reactions = this.state.reactions.filter(item => Date.parse(item.createdAt) > this.now() - 10000);
            this.state.reactions.push({ id: randomUUID(), userId: actor.userId, displayName: actor.displayName, emoji, createdAt: this.iso(), ...(clientId ? { clientId } : {}) }); break;
          }
          case 'admin.assign': {
            this.requireOwner(actor); const id = text(command.userId, 'userId'); const admin = bool(command.admin, 'admin');
            if (id === this.state.adminConfiguration.ownerUserId) fail(400, 'owner_immutable', 'Owner authority is controlled by local configuration.');
            this.state.adminConfiguration.explicitAdminUserIds = this.state.adminConfiguration.explicitAdminUserIds.filter(item => item !== id);
            if (admin) this.state.adminConfiguration.explicitAdminUserIds.push(id);
            // Removing an explicit grant does not revoke an independent Discord-role grant.
            // Preserve a known admin until server authentication refreshes their actual flags.
            if (admin && Object.hasOwn(this.state.users, id)) this.state.users[id].isAdmin = true;
            break;
          }
          case 'admin.roles': {
            this.requireOwner(actor);
            if (!Array.isArray(command.roleIds) || command.roleIds.length > 50) fail(400, 'invalid_roles', 'Provide at most fifty Discord role IDs.');
            this.state.adminConfiguration.adminRoleIds = [...new Set(command.roleIds.map(id => text(id, 'roleId')))];
            this.state.adminRolesConfigured = true; break;
          }
          default: fail(400, 'unknown_command', 'Unknown room command.');
        }
        this.save(administrative ? this.event(actor, type, targetId, 'success', undefined, this.state.live?.id ?? sessionId) : undefined);
        return { ok: true, snapshot: this.snapshot(actor), ...(admission ? { admission: structuredClone(admission) } : {}), ...(reservation ? { reservation: structuredClone(reservation) } : {}) };
      } catch (error) {
        if (administrative) this.save(this.event(actor, type, targetId, error instanceof DomainError && error.status < 500 ? 'denied' : 'failed', error instanceof DomainError ? error.code : 'media_or_storage_failure', sessionId));
        throw error;
      }
    });
  }

  close(): void { this.store.close(); }
}

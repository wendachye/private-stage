import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { AccessToken, RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import { SignalRequest, SignalResponse, TrackSource, TrackType, type ParticipantInfo } from '@livekit/protocol';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { MediaPolicy, MediaSource } from '../../../shared/types.js';
import { MediaPolicyError, PublicationGuard } from './guard.js';

export interface MediaControllerOptions {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Root must bind the request's authenticated session AND device cookie to this admission. */
  authorize(request: IncomingMessage, identity: string, roomName: string): Promise<MediaPolicy | null>;
  onConnection?(identity: string, connected: boolean): Promise<void>;
  onPublicationStopped?(identity: string, source: MediaSource, reservationId?: string): Promise<void>;
  log?: { warn(data: unknown, message?: string): void };
  /** Injectable for integration checks; production defaults to the official SDK client. */
  roomService?: Pick<RoomServiceClient, 'createRoom' | 'listRooms' | 'listParticipants' | 'getParticipant' | 'updateParticipant' | 'removeParticipant' | 'deleteRoom' | 'mutePublishedTrack'>;
}

interface Bridge {
  identity: string;
  roomName: string;
  request: IncomingMessage;
  client: WebSocket;
  upstream: WebSocket;
  closing: boolean;
  selfSnapshot?: { sid: string; version: number };
  publicationCheckInFlight?: boolean;
}

const sourceNumber: Record<MediaSource, TrackSource> = { microphone: TrackSource.MICROPHONE, screen_share: TrackSource.SCREEN_SHARE, screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO };
const sourceName = (source: number): MediaSource => {
  if (source === TrackSource.MICROPHONE) return 'microphone';
  if (source === TrackSource.SCREEN_SHARE) return 'screen_share';
  if (source === TrackSource.SCREEN_SHARE_AUDIO) return 'screen_share_audio';
  throw new MediaPolicyError('source_not_allowed', 'Camera and unspecified track sources are not enabled.');
};
const allowedSignalCases = new Set(['offer', 'answer', 'trickle', 'addTrack', 'mute', 'subscription', 'trackSetting', 'leave', 'updateLayers', 'subscriptionPermission', 'syncState', 'ping', 'pingReq', 'updateAudioTrack', 'updateVideoTrack']);
const allowedQuery = new Set(['protocol', 'client_protocol', 'version', 'sdk', 'auto_subscribe', 'adaptive_stream', 'disable_ice_lite', 'subscriber_allow_pause', 'reconnect', 'sid', 'reconnect_reason', 'os', 'os_version', 'browser', 'browser_version', 'device_model', 'network', 'capabilities']);

const isNotFound = (error: unknown) => {
  const candidate = error as { code?: string; status?: number; statusCode?: number };
  return candidate?.code === 'not_found' || candidate?.status === 404 || candidate?.statusCode === 404;
};
const asBytes = (data: RawData) => data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(Buffer.concat(data));

export class MediaController {
  readonly guard = new PublicationGuard(3);
  private readonly verifier: TokenVerifier;
  private readonly api: NonNullable<MediaControllerOptions['roomService']>;
  private readonly sockets = new Set<Bridge>();
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: MediaControllerOptions) {
    this.verifier = new TokenVerifier(options.apiKey, options.apiSecret);
    this.api = options.roomService ?? new RoomServiceClient(options.livekitUrl, options.apiKey, options.apiSecret);
  }

  async issueToken(policy: MediaPolicy) {
    if (!policy.active) throw new MediaPolicyError('admission_required', 'A current room admission is required.');
    const token = new AccessToken(this.options.apiKey, this.options.apiSecret, { identity: policy.identity, name: policy.displayName, ttl: '10m' });
    token.addGrant({ room: policy.roomName, roomJoin: true, canSubscribe: true, canPublish: policy.allowedSources.length > 0, canPublishSources: policy.allowedSources.map(source => sourceNumber[source]), canPublishData: false, canUpdateOwnMetadata: false });
    return token.toJwt();
  }

  async validate(request: IncomingMessage): Promise<MediaPolicy> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/rtc' && url.pathname !== '/rtc/validate') throw new MediaPolicyError('unsupported_signal_path', 'Only the classic LiveKit signal path is enabled.');
    const queryToken = url.searchParams.get('access_token');
    const bearerToken = request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
    if (queryToken && bearerToken && queryToken !== bearerToken) throw new MediaPolicyError('conflicting_token', 'Conflicting media credentials were supplied.');
    const token = queryToken ?? bearerToken;
    if (!token || token.length > 16384) throw new MediaPolicyError('token_required', 'A media credential is required.');
    const claims = await this.verifier.verify(token);
    const identity = claims.sub;
    const roomName = claims.video?.room;
    if (!identity || !roomName || !claims.video?.roomJoin) throw new MediaPolicyError('invalid_token', 'The media credential has no room admission.');
    const policy = await this.options.authorize(request, identity, roomName);
    if (!policy?.active || policy.identity !== identity || policy.roomName !== roomName) throw new MediaPolicyError('admission_revoked', 'Room admission is no longer valid.');
    return policy;
  }

  attach(server: HttpServer) {
    server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/rtc')) return;
      void this.upgrade(request, socket, head);
    });
    this.timer = setInterval(() => { void this.sweep().catch(error => this.warn('Media connection sweep failed', error)); }, 2000);
    this.timer.unref();
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (requestUrl.pathname !== '/rtc') { this.reject(socket, 404, 'Unsupported signal path'); return; }
    try {
      const policy = await this.validate(request);
      // Never forward join_request/embedded offers, original credentials, or arbitrary backend paths.
      const upstreamUrl = new URL(this.options.livekitUrl.replace(/^http/u, 'ws'));
      upstreamUrl.pathname = '/rtc';
      upstreamUrl.search = '';
      for (const [key, value] of requestUrl.searchParams) if (allowedQuery.has(key)) upstreamUrl.searchParams.set(key, value);
      upstreamUrl.searchParams.set('access_token', await this.issueToken(policy));
      if (socket.destroyed) return;
      this.websocketServer.handleUpgrade(request, socket, head, client => {
        const upstream = new WebSocket(upstreamUrl, { maxPayload: 512 * 1024, perMessageDeflate: false, handshakeTimeout: 8000 });
        const bridge: Bridge = { identity: policy.identity, roomName: policy.roomName, request, client, upstream, closing: false };
        this.sockets.add(bridge);
        const pending: Array<{ data: RawData; binary: boolean; message: SignalRequest; size: number }> = [];
        let pendingBytes = 0;
        let chain = Promise.resolve();
        let queued = 0;
        let queuedBytes = 0;
        let windowStarted = Date.now();
        let windowControlMessages = 0;
        let windowIceMessages = 0;
        const enqueue = (data: RawData, binary: boolean, message: SignalRequest, size: number) => {
          if (bridge.closing) return;
          if (queued >= 256 || queuedBytes + size > 1024 * 1024) { this.stop(bridge, 1008, 'Signal queue limit'); return; }
          queued++;
          queuedBytes += size;
          chain = chain.then(() => this.forwardRequest(bridge, binary, message)).catch(error => this.denyBridge(bridge, error)).finally(() => { queued--; queuedBytes -= size; });
        };
        client.on('message', (data, binary) => {
          if (bridge.closing) return;
          let message: SignalRequest;
          try { message = binary ? SignalRequest.fromBinary(asBytes(data)) : SignalRequest.fromJson(JSON.parse(data.toString())); }
          catch { this.stop(bridge, 1008, 'Invalid signaling message'); return; }
          if (!message.message.case || !allowedSignalCases.has(message.message.case)) { this.stop(bridge, 1008, 'Unsupported signaling message'); return; }
          const now = Date.now();
          if (now - windowStarted >= 10000) { windowStarted = now; windowControlMessages = 0; windowIceMessages = 0; }
          // Native WebRTC can emit a large valid ICE burst on multi-interface Windows hosts.
          if (message.message.case === 'trickle') windowIceMessages++; else windowControlMessages++;
          if (windowControlMessages > 120 || windowIceMessages > 1000) { this.stop(bridge, 1008, 'Signal rate limit'); return; }
          const size = asBytes(data).byteLength;
          if (upstream.readyState === WebSocket.CONNECTING) {
            if (pending.length >= 256 || pendingBytes + size > 1024 * 1024) { this.stop(bridge, 1008, 'Signal queue limit'); return; }
            pendingBytes += size;
            pending.push({ data, binary, message, size });
            return;
          }
          enqueue(data, binary, message, size);
        });
        upstream.on('open', () => {
          for (const { data, binary, message, size } of pending) enqueue(data, binary, message, size);
          pending.length = 0;
          pendingBytes = 0;
        });
        let responseChain = Promise.resolve();
        let responseQueued = 0;
        upstream.on('message', (data, binary) => {
          if (bridge.closing) return;
          if (responseQueued >= 64) { this.stop(bridge, 1008, 'Signal response queue limit'); return; }
          responseQueued++;
          responseChain = responseChain.then(() => this.forwardResponse(bridge, data, binary)).catch(error => this.denyBridge(bridge, error)).finally(() => { responseQueued--; });
        });
        upstream.on('unexpected-response', () => this.stop(bridge, 1011, 'Media service rejected connection'));
        upstream.on('error', () => this.stop(bridge, 1011, 'Media service unavailable'));
        client.on('error', () => this.stop(bridge, 1011, 'Client connection failed'));
        upstream.on('close', () => this.stop(bridge, 1000, 'Media connection closed'));
        client.on('close', () => this.stop(bridge, 1000, 'Client disconnected'));
      });
    } catch { this.reject(socket, 403, 'Media admission denied'); }
  }

  private async forwardRequest(bridge: Bridge, binary: boolean, message: SignalRequest) {
    if (bridge.closing || bridge.upstream.readyState !== WebSocket.OPEN) return;
    if (bridge.upstream.bufferedAmount > 1024 * 1024) throw new MediaPolicyError('upstream_backpressure', 'The media signaling connection is overloaded.');
    const policy = await this.options.authorize(bridge.request, bridge.identity, bridge.roomName);
    if (!policy?.active) throw new MediaPolicyError('admission_revoked', 'Admission has ended.');
    const request = message.message;
    if (!request.case || !allowedSignalCases.has(request.case)) throw new MediaPolicyError('unsupported_signal_message', 'The signal message is not enabled.');
    if (request.case === 'addTrack') {
      const track = request.value;
      if (track.type !== TrackType.AUDIO && track.type !== TrackType.VIDEO) throw new MediaPolicyError('invalid_track_kind', 'Only audio and video publications are enabled.');
      this.guard.reserve(policy, { cid: track.cid, sid: track.sid || undefined, source: sourceName(track.source), kind: track.type === TrackType.AUDIO ? 'audio' : 'video' });
    } else if (request.case === 'syncState') {
      this.guard.assertSync(bridge.identity, request.value.publishTracks.map(track => ({ cid: track.cid, sid: track.track?.sid ?? '', source: sourceName(track.track?.source ?? TrackSource.UNKNOWN) })));
    }
    // Canonical encoding strips unknown protobuf fields instead of forwarding opaque extensions.
    bridge.upstream.send(binary ? message.toBinary() : message.toJsonString(), { binary });
  }

  private async forwardResponse(bridge: Bridge, data: RawData, binary: boolean) {
    if (bridge.closing || bridge.client.readyState !== WebSocket.OPEN) return;
    if (bridge.client.bufferedAmount > 1024 * 1024) throw new MediaPolicyError('client_backpressure', 'The client is not draining media signaling.');
    const policy = await this.options.authorize(bridge.request, bridge.identity, bridge.roomName);
    if (!policy?.active) throw new MediaPolicyError('admission_revoked', 'Admission has ended.');
    const message = binary ? SignalResponse.fromBinary(asBytes(data)) : SignalResponse.fromJson(JSON.parse(data.toString()), { ignoreUnknownFields: true });
    const response = message.message;
    if (response.case === 'trackPublished') {
      const track = response.value.track;
      if (!track) throw new MediaPolicyError('invalid_publication', 'Media publication response is incomplete.');
      this.guard.confirm(bridge.identity, response.value.cid, track.sid, sourceName(track.source));
    } else if (response.case === 'trackUnpublished') {
      const stopped = this.guard.snapshot().find(track => track.identity === bridge.identity && track.sid === response.value.trackSid);
      this.guard.removeSid(bridge.identity, response.value.trackSid);
      if (stopped) this.notifyStopped(bridge.identity, stopped.source, stopped.reservationId);
    } else if (response.case === 'update') {
      const self = response.value.participants.find(participant => participant.identity === bridge.identity);
      if (self && !(bridge.selfSnapshot?.sid === self.sid && bridge.selfSnapshot.version > self.version)) {
        bridge.selfSnapshot = { sid: self.sid, version: self.version };
        const publications = this.guard.snapshot().filter(track => track.identity === bridge.identity && track.published);
        this.observePublications(publications, self);
        const missing = publications.filter(track => !self.tracks.some(present => present.sid === track.sid));
        if (missing.length) this.verifyMissingPublications(bridge, missing);
      }
    } else if (response.case === 'join') {
      const self = response.value.participant;
      if (self) {
        bridge.selfSnapshot = { sid: self.sid, version: self.version };
        this.observePublications(this.guard.snapshot().filter(track => track.identity === bridge.identity), self);
      }
      await this.options.onConnection?.(bridge.identity, true);
    }
    // Server responses, including refreshed credentials, are delivered intact; those credentials are
    // re-authorized and replaced from current policy on every subsequent gateway connection.
    bridge.client.send(data, { binary });
  }

  private observePublications(candidates: ReturnType<PublicationGuard['snapshot']>, participant: ParticipantInfo) {
    for (const candidate of candidates) {
      if (candidate.identity === participant.identity && participant.tracks.some(track => track.sid === candidate.sid && track.source === sourceNumber[candidate.source])) {
        this.guard.observe(candidate, participant.sid, participant.version);
      }
    }
  }

  private verifyMissingPublications(bridge: Bridge, candidates: ReturnType<PublicationGuard['snapshot']>) {
    if (bridge.publicationCheckInFlight || bridge.closing) return;
    bridge.publicationCheckInFlight = true;
    // Participant snapshots can precede a newly acknowledged publication. Verify
    // absence with current SFU metadata off the signaling response chain, so a
    // slow control API never holds up publication acknowledgements or ICE.
    const request = Promise.resolve().then(() => this.api.getParticipant(bridge.roomName, bridge.identity));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const participant = await Promise.race([
          request,
          new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 1000); timeout.unref(); }),
        ]);
        if (!participant || bridge.closing || participant.identity !== bridge.identity) return;
        const latest = bridge.selfSnapshot;
        if (latest && (latest.sid !== participant.sid || latest.version > participant.version)) return;
        this.observePublications(candidates, participant);
        for (const candidate of candidates) {
          if (!candidate.sid || participant.tracks.some(track => track.sid === candidate.sid)) continue;
          if (!this.guard.canConfirmAbsence(candidate, participant.sid, participant.version)) continue;
          const current = this.guard.snapshot().find(track => track.identity === bridge.identity && track.sid === candidate.sid
            && track.source === candidate.source && track.reservationId === candidate.reservationId && track.published);
          if (!current) continue;
          this.guard.removeSid(bridge.identity, candidate.sid);
          this.notifyStopped(bridge.identity, current.source, current.reservationId);
        }
      } catch (error) { this.warn('Publication absence verification is pending', error); }
      finally {
        if (timeout) clearTimeout(timeout);
        // Even after the observation timeout, allow only one actual control API
        // request per bridge until it settles. Failures retain quota leases.
        await request.catch(() => undefined);
        bridge.publicationCheckInFlight = false;
      }
    })();
  }

  private reject(socket: Duplex, status: number, message: string) { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Forbidden'}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`); }
  private stop(bridge: Bridge, code: number, reason: string) {
    if (bridge.closing) return;
    if (code === 1008) this.options.log?.warn({ code: 'signal_closed', reason }, 'Media signal closed by policy');
    bridge.closing = true;
    this.sockets.delete(bridge);
    if (bridge.client.readyState === WebSocket.OPEN) bridge.client.close(code, reason);
    else if (bridge.client.readyState === WebSocket.CONNECTING) bridge.client.terminate();
    if (bridge.upstream.readyState === WebSocket.OPEN) bridge.upstream.close(code, reason);
    else if (bridge.upstream.readyState === WebSocket.CONNECTING) bridge.upstream.terminate();
    // Keep track leases until SFU removal is confirmed; a closed signal socket may retain media.
    if (![...this.sockets].some(other => other.identity === bridge.identity)) void this.options.onConnection?.(bridge.identity, false).catch(error => this.warn('Connection status update failed', error));
  }
  private denyBridge(bridge: Bridge, error: unknown) { this.warn('Signal publication denied', error); this.stop(bridge, 1008, 'Room media policy denied this operation'); }
  private warn(message: string, error: unknown) { this.options.log?.warn({ code: error instanceof MediaPolicyError ? error.code : 'media_error' }, message); }
  private notifyStopped(identity: string, source: MediaSource, reservationId?: string) {
    // Domain callbacks may themselves await media effects. Never await from this media boundary.
    void this.options.onPublicationStopped?.(identity, source, reservationId).catch(error => this.warn('Publication cleanup is pending', error));
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async health() { try { await this.api.listRooms(); return true; } catch { return false; } }

  async hasScreen(identity: string, roomName: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    do {
      try { if ((await this.api.getParticipant(roomName, identity)).tracks.some(track => track.source === TrackSource.SCREEN_SHARE)) return true; }
      catch (error) { if (!isNotFound(error)) throw error; }
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (true);
  }

  async ensureRoom(roomName: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(roomName)) throw new MediaPolicyError('invalid_room', 'The media room identity is invalid.');
    return this.serialized(async () => {
      const rooms = await this.api.listRooms([roomName]);
      if (!rooms.some(room => room.name === roomName)) await this.api.createRoom({ name: roomName, emptyTimeout: 300, departureTimeout: 30, maxParticipants: 40 });
    });
  }

  async reconcile(roomName: string, policies: MediaPolicy[]) {
    return this.serialized(async () => {
      const allowed = new Map(policies.filter(policy => policy.active).map(policy => [policy.identity, policy]));
      const present = new Set<string>();
      let participants;
      try { participants = await this.api.listParticipants(roomName); }
      catch (error) { if (isNotFound(error)) return; throw error; }
      // Phase 1: remove/restrict every prior publisher before ANY permission can be broadened.
      for (const participant of participants) {
        const policy = allowed.get(participant.identity);
        if (!policy) { await this.removeInternal(roomName, participant.identity); continue; }
        const current = participant.permission?.canPublishSources ?? [];
        const intersection = policy.allowedSources.filter(source => current.includes(sourceNumber[source]));
        const publications = this.guard.snapshot().filter(track => track.identity === participant.identity && track.published);
        let restricted;
        try {
          await this.api.updateParticipant(roomName, participant.identity, { permission: { canPublish: intersection.length > 0, canPublishSources: intersection.map(source => sourceNumber[source]), canPublishData: false, canSubscribe: true, canUpdateMetadata: false } });
          restricted = await this.api.getParticipant(roomName, participant.identity);
        } catch (error) {
          if (await this.participantAbsent(roomName, participant.identity)) { this.guard.removeIdentity(participant.identity); continue; }
          throw error;
        }
        if (restricted.tracks.some(track => !intersection.some(source => sourceNumber[source] === track.source))) {
          throw new MediaPolicyError('revocation_unconfirmed', 'Previous media publication has not stopped.');
        }
        this.guard.removeSources(participant.identity, intersection);
        this.observePublications(publications, restricted);
        for (const lease of publications) {
          if (!restricted.tracks.some(track => track.sid === lease.sid) && this.guard.canConfirmAbsence(lease, restricted.sid, restricted.version)) this.guard.removeSid(participant.identity, lease.sid ?? '');
        }
        present.add(participant.identity);
      }
      // Phase 2: only after the previous publishing sources are gone, permit new owners.
      for (const participant of participants) {
        const policy = allowed.get(participant.identity);
        if (!policy || !present.has(participant.identity)) continue;
        try { await this.api.updateParticipant(roomName, participant.identity, { permission: { canPublish: policy.allowedSources.length > 0, canPublishSources: policy.allowedSources.map(source => sourceNumber[source]), canPublishData: false, canSubscribe: true, canUpdateMetadata: false } }); }
        catch (error) { if (await this.participantAbsent(roomName, participant.identity)) this.guard.removeIdentity(participant.identity); else throw error; }
      }
    });
  }

  private async removeInternal(roomName: string, identity: string) {
    try { await this.api.removeParticipant(roomName, identity); }
    catch (error) { if (!isNotFound(error) && !await this.participantAbsent(roomName, identity)) throw error; }
    this.guard.removeIdentity(identity);
    for (const bridge of this.sockets) if (bridge.identity === identity) this.stop(bridge, 1008, 'Room admission ended');
  }
  private async participantAbsent(roomName: string, identity: string) {
    try { return !(await this.api.listParticipants(roomName)).some(participant => participant.identity === identity); }
    catch (error) { return isNotFound(error); }
  }
  async remove(roomName: string, identity: string) { return this.serialized(() => this.removeInternal(roomName, identity)); }
  async closeRoom(roomName: string) {
    return this.serialized(async () => {
      try { await this.api.deleteRoom(roomName); } catch (error) { if (!isNotFound(error)) throw error; }
      this.guard.removeRoom(roomName);
      for (const bridge of this.sockets) if (bridge.roomName === roomName) this.stop(bridge, 1008, 'Live session ended');
    });
  }
  async mute(roomName: string, identity: string) {
    return this.serialized(async () => {
      let participant;
      try { participant = await this.api.getParticipant(roomName, identity); } catch (error) { if (isNotFound(error)) return; throw error; }
      for (const track of participant.tracks) if (track.source === TrackSource.MICROPHONE) await this.api.mutePublishedTrack(roomName, identity, track.sid, true);
    });
  }

  private async sweep() {
    for (const bridge of this.sockets) {
      const policy = await this.options.authorize(bridge.request, bridge.identity, bridge.roomName).catch(() => null);
      if (!policy?.active) {
        // An authority failure immediately stops the signal path; successful SFU removal is also required.
        this.stop(bridge, 1008, 'Room admission is unavailable');
        await this.remove(bridge.roomName, bridge.identity);
      }
    }
    for (const identity of this.guard.pendingExpired(30000)) {
      const lease = this.guard.snapshot().find(track => track.identity === identity);
      if (lease) await this.remove(lease.roomName, identity);
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    for (const bridge of this.sockets) this.stop(bridge, 1001, 'Application stopping');
    this.websocketServer.close();
  }
}

export const createMediaController = (options: MediaControllerOptions) => new MediaController(options);

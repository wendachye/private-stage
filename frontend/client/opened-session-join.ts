import type { RoomSnapshot } from '../../shared/types';

export interface OpeningJoinCapture { readonly scope: string; readonly epoch: number }
export interface OpenedSessionJoinTicket {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly admissionId: string;
  readonly revision: number;
}

export function matchesOpenedSessionJoin(ticket: OpenedSessionJoinTicket, state: RoomSnapshot | null): boolean {
  return !!state && state.revision >= ticket.revision && state.self.userId === ticket.userId
    && state.self.deviceId === ticket.deviceId && (state.self.isAdmin || state.self.isOwner)
    && state.session?.id === ticket.sessionId && state.self.admission?.id === ticket.admissionId
    && !state.self.admission.revoked;
}

/** Only the browser that successfully opened a session may request one automatic media join. */
export class OpenedSessionJoinGate {
  private scope = '';
  private epoch = 0;
  private pending: OpenedSessionJoinTicket | null = null;

  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.clear();
  }

  clear(): void { this.epoch++; this.pending = null; }
  capture(): OpeningJoinCapture { return Object.freeze({ scope: this.scope, epoch: this.epoch }); }

  queue(capture: OpeningJoinCapture, opened: RoomSnapshot): boolean {
    const admission = opened.self.admission, session = opened.session;
    if (capture.scope !== this.scope || capture.epoch !== this.epoch || !session || !admission
      || admission.revoked || admission.sessionId !== session.id
      || admission.userId !== opened.self.userId || admission.deviceId !== opened.self.deviceId
      || !(opened.self.isAdmin || opened.self.isOwner)) return false;
    this.pending = Object.freeze({ userId: opened.self.userId, deviceId: opened.self.deviceId,
      sessionId: session.id, admissionId: admission.id, revision: opened.revision });
    return true;
  }

  take(state: RoomSnapshot | null, joinPending = false): OpenedSessionJoinTicket | null {
    const ticket = this.pending;
    if (!ticket) return null;
    if (!state || state.self.userId !== ticket.userId || state.self.deviceId !== ticket.deviceId
      || !(state.self.isAdmin || state.self.isOwner)) { this.pending = null; return null; }
    // A successful command can arrive before React applies its authoritative snapshot.
    if (state.revision < ticket.revision) return null;
    if (!matchesOpenedSessionJoin(ticket, state)) { this.pending = null; return null; }
    // An earlier room's token/connect request must finish before this opening can connect.
    if (joinPending) return null;
    this.pending = null;
    return ticket;
  }
}

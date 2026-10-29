export interface DialogTicket {
  readonly scope: string;
  readonly revision: number;
}

/** A dialog and its async completion belong to one identity, session, and opening. */
export class DialogScopeGate {
  private scope = '';
  private revision = 0;

  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.revision++;
  }

  open(): DialogTicket {
    return Object.freeze({ scope: this.scope, revision: ++this.revision });
  }

  current(ticket: DialogTicket): boolean {
    return ticket.scope === this.scope && ticket.revision === this.revision;
  }

  close(ticket: DialogTicket): boolean {
    if (!this.current(ticket)) return false;
    this.revision++;
    return true;
  }
}

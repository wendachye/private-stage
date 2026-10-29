interface StoppableTrack { stop(): void }

export interface ScreenCaptureAdapter<T extends StoppableTrack> {
  scope(): string | null;
  allowed(scope: string): boolean;
  reserve(): Promise<string>;
  confirm(reservationId: string): Promise<void>;
  release(): Promise<void>;
  unpublish(track: T): Promise<void>;
  onEnded(tracks: T[], ended: () => void): void;
  changed(state: { pending: boolean; active: boolean }): void;
  failed(error: unknown): void;
}

interface Attempt<T> {
  scope: string;
  cancelled: boolean;
  active: boolean;
  tracks: T[];
  reservation?: Promise<string>;
  publication?: Promise<void>;
  cleanup?: Promise<void>;
}

class CancelledCapture extends Error {}

/** One capture operation owns its tracks and cleanup until its reservation is released. */
export class ScreenCaptureController<T extends StoppableTrack> {
  private current?: Attempt<T>;
  constructor(private readonly adapter: ScreenCaptureAdapter<T>) {}

  get active() { return this.current?.active ?? false; }
  get pending() { return !!this.current && !this.current.active; }

  reconcile(): void {
    if (this.current && !this.valid(this.current)) void this.stop();
  }

  async start(capture: () => Promise<T[]>, publish: (track: T) => Promise<void>): Promise<boolean> {
    if (this.current) return false;
    const scope = this.adapter.scope();
    if (!scope || !this.adapter.allowed(scope)) return false;
    // Capture must be invoked synchronously during the original user gesture.
    let captured: Promise<T[]>;
    try { captured = Promise.resolve(capture()); }
    catch (error) { this.adapter.failed(error); return false; }
    const attempt: Attempt<T> = { scope, cancelled: false, active: false, tracks: [] };
    this.current = attempt;
    this.adapter.changed({ pending: true, active: false });
    void captured.then(tracks => {
      attempt.tracks = tracks;
      if (attempt.cancelled || !this.valid(attempt)) tracks.forEach(track => track.stop());
      else this.adapter.onEnded(tracks, () => {
        // Listen before reservation/publication completes, including native Stop Sharing.
        if (this.current === attempt && !attempt.cancelled) void this.stop();
      });
    }).catch(() => undefined);
    try {
      const tracks = await captured;
      attempt.tracks = tracks;
      this.assertValid(attempt);
      // A native chooser may stay open longer than the short publication lease.
      // Acquire quota only after selection, before publishing any captured source.
      attempt.reservation = this.adapter.reserve();
      const reservationId = await attempt.reservation;
      this.assertValid(attempt);
      for (const track of tracks) {
        this.assertValid(attempt);
        attempt.publication = publish(track);
        await attempt.publication;
        this.assertValid(attempt);
      }
      await this.adapter.confirm(reservationId);
      this.assertValid(attempt);
      attempt.active = true;
      this.adapter.changed({ pending: false, active: true });
      return true;
    } catch (error) {
      const report = !attempt.cancelled && !(error instanceof CancelledCapture);
      attempt.cancelled = true;
      await this.cleanup(attempt);
      if (report) this.adapter.failed(error);
      return false;
    }
  }

  async stop(): Promise<void> {
    const attempt = this.current;
    if (!attempt) return;
    attempt.cancelled = true;
    await this.cleanup(attempt);
  }

  private valid(attempt: Attempt<T>) {
    return this.current === attempt && !attempt.cancelled && this.adapter.allowed(attempt.scope);
  }
  private assertValid(attempt: Attempt<T>) {
    if (!this.valid(attempt)) throw new CancelledCapture();
  }
  private cleanup(attempt: Attempt<T>): Promise<void> {
    if (attempt.cleanup) return attempt.cleanup;
    // Stop local collection immediately, including while publish/reserve is still outstanding.
    attempt.tracks.forEach(track => track.stop());
    attempt.cleanup = (async () => {
      // A late publish completion must be unpublished before another attempt may begin.
      await attempt.publication?.catch(() => undefined);
      for (const track of attempt.tracks) {
        await this.adapter.unpublish(track).catch(() => undefined);
        track.stop();
      }
      const reserved = attempt.reservation ? await attempt.reservation.then(() => true, () => false) : false;
      // The release command is device-scoped. Never send old cleanup into a new admission.
      if (reserved && this.adapter.scope() === attempt.scope) {
        await this.adapter.release().catch(error => this.adapter.failed(error));
      }
      if (this.current === attempt) {
        this.current = undefined;
        this.adapter.changed({ pending: false, active: false });
      }
    })();
    return attempt.cleanup;
  }
}

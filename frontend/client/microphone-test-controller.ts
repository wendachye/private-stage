export type MicrophoneTestPhase = 'idle' | 'pending' | 'active';
interface TestStream { getTracks(): Array<{ stop(): void }> }
interface Attempt<S> { stream?: S; dispose?: () => void }

/** Owns local test capture across permission prompts, cancellation, and replacement tests. */
export class MicrophoneTestController<S extends TestStream> {
  private current?: Attempt<S>;
  constructor(private readonly changed: (phase: MicrophoneTestPhase) => void, private readonly failed: (error: unknown) => void) {}

  get running() { return !!this.current; }

  async start(capture: () => Promise<S>, meter: (stream: S) => () => void): Promise<void> {
    if (this.current) return;
    const attempt: Attempt<S> = {};
    this.current = attempt;
    this.changed('pending');
    try {
      attempt.stream = await capture();
      if (this.current !== attempt) { this.cleanup(attempt); return; }
      attempt.dispose = meter(attempt.stream);
      if (this.current !== attempt) { this.cleanup(attempt); return; }
      this.changed('active');
    } catch (error) {
      this.cleanup(attempt);
      if (this.current === attempt) {
        this.current = undefined;
        this.changed('idle');
        this.failed(error);
      }
    }
  }

  stop(): void {
    const attempt = this.current;
    if (!attempt) return;
    this.current = undefined;
    this.cleanup(attempt);
    this.changed('idle');
  }

  private cleanup(attempt: Attempt<S>) {
    attempt.stream?.getTracks().forEach(track => track.stop());
    attempt.stream = undefined;
    const dispose = attempt.dispose;
    attempt.dispose = undefined;
    dispose?.();
  }
}

/** Every partial Web Audio setup failure releases the context; caller owns the stream. */
export function createMicrophoneMeter(stream: MediaStream, level: (value: number) => void,
  environment = { createAudio: () => new AudioContext(), frame: (callback: FrameRequestCallback) => requestAnimationFrame(callback), cancel: (id: number) => cancelAnimationFrame(id) },
  failed?: (error: unknown) => void): () => void {
  const audio = environment.createAudio();
  let frame = 0, stopped = false;
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    environment.cancel(frame);
    void audio.close().catch(() => undefined);
  };
  try {
    const analyser = audio.createAnalyser();
    analyser.fftSize = 256;
    audio.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const update = () => {
      if (stopped) return;
      try {
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((total, point) => total + ((point - 128) / 128) ** 2, 0) / data.length);
        level(Math.min(100, rms * 350));
        frame = environment.frame(update);
      } catch (error) {
        dispose();
        stream.getTracks().forEach(track => track.stop());
        failed?.(error);
      }
    };
    update();
    return dispose;
  } catch (error) { dispose(); throw error; }
}

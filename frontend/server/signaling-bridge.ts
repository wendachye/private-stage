import WebSocket, { type ClientOptions, type RawData } from 'ws';

export const SIGNAL_MAX_PAYLOAD = 512 * 1024;
const defaultLimits = { maxPayload: SIGNAL_MAX_PAYLOAD, maxBufferedBytes: 1024 * 1024, maxPendingMessages: 64,
  handshakeTimeoutMs: 8000, handoffTimeoutMs: 8000, lifetimeMs: 290000, closeTimeoutMs: 1000 };

export class SignalingConnectionError extends Error {
  constructor(readonly status: number) { super('Media signaling connection unavailable.'); }
}

export type SignalConnector = (target: URL, options: ClientOptions) => WebSocket;
export interface SignalingBridgeOptions {
  target: URL;
  headers: Record<string, string>;
  signal?: AbortSignal;
  connect?: SignalConnector;
  limits?: Partial<typeof defaultLimits>;
}

const bytes = (data: RawData) => Buffer.isBuffer(data) ? Buffer.from(data)
  : data instanceof ArrayBuffer ? Buffer.from(data.slice(0)) : Buffer.concat(data);
const closeCode = (code: number) => code >= 3000 && code <= 4999
  || [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) ? code : 1011;

/** Opens only the caller-selected server-side gateway; admission remains upstream. */
export async function connectSignalingBridge(options: SignalingBridgeOptions) {
  const startedAt = Date.now();
  const limits = { ...defaultLimits, ...options.limits };
  if (options.signal?.aborted) throw new SignalingConnectionError(400);
  const upstream = (options.connect ?? ((url, settings) => new WebSocket(url, settings)))(options.target, {
    headers: options.headers, maxPayload: limits.maxPayload, perMessageDeflate: false,
    handshakeTimeout: limits.handshakeTimeoutMs, followRedirects: false,
  });
  let client: WebSocket | undefined;
  let closing = false, opened = false, pendingBytes = 0;
  const pending: Array<{ data: Buffer; binary: boolean }> = [];
  let resolveReady!: () => void, rejectReady!: (error: SignalingConnectionError) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forceClose: ReturnType<typeof setTimeout> | undefined;
  const stop = (code = 1011, reason = 'Media connection closed', status = 502) => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    pending.length = 0; pendingBytes = 0;
    if (!opened) rejectReady(new SignalingConnectionError(status));
    for (const socket of [upstream, client]) {
      if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket?.readyState === WebSocket.OPEN) socket.close(closeCode(code), reason);
    }
    forceClose = setTimeout(() => {
      for (const socket of [upstream, client]) if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, limits.closeTimeoutMs);
    forceClose.unref();
  };
  const abort = () => stop(1001, 'Connection cancelled', 400);
  const arm = (duration: number, code: number, reason: string, status = 502) => {
    clearTimeout(timer); timer = setTimeout(() => stop(code, reason, status), duration); timer.unref();
  };
  const forward = (destination: WebSocket, data: Buffer, binary: boolean) => {
    if (closing) return;
    if (data.length > limits.maxPayload) { stop(1009, 'Signal message limit'); return; }
    if (destination.readyState !== WebSocket.OPEN) { stop(); return; }
    if (destination.bufferedAmount + data.length > limits.maxBufferedBytes) { stop(1013, 'Signal buffer limit'); return; }
    try { destination.send(data, { binary }, error => { if (error) stop(); }); }
    catch { stop(); }
  };
  upstream.on('message', (data, binary) => {
    if (closing) return;
    const frame = bytes(data);
    if (frame.length > limits.maxPayload) { stop(1009, 'Signal message limit'); return; }
    if (client) { forward(client, frame, binary); return; }
    if (pending.length >= limits.maxPendingMessages || pendingBytes + frame.length > limits.maxBufferedBytes) {
      stop(1013, 'Signal buffer limit'); return;
    }
    pending.push({ data: frame, binary }); pendingBytes += frame.length;
  });
  upstream.once('open', () => {
    if (closing) return;
    opened = true;
    arm(limits.handoffTimeoutMs, 1011, 'Client upgrade timed out');
    resolveReady();
  });
  upstream.on('error', () => stop());
  upstream.once('unexpected-response', (request, response) => {
    const status = response.statusCode === 401 || response.statusCode === 403 ? 403 : 502;
    stop(1008, 'Media admission denied', status);
    response.destroy(); request.destroy();
  });
  upstream.once('close', code => {
    stop(code);
    if (!client || client.readyState === WebSocket.CLOSED) clearTimeout(forceClose);
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  arm(limits.handshakeTimeoutMs, 1011, 'Media connection timed out', 504);
  await ready;
  if (closing) throw new SignalingConnectionError(502);
  return {
    attach(socket: WebSocket) {
      if (client || closing || upstream.readyState !== WebSocket.OPEN) {
        socket.on('error', () => {}); socket.close(1011, 'Media connection unavailable');
        stop(); return;
      }
      client = socket;
      // After upgrade, socket close owns cancellation; HTTP response completion must not stop media.
      options.signal?.removeEventListener('abort', abort);
      socket.on('error', () => stop());
      socket.once('close', code => { stop(code); if (upstream.readyState === WebSocket.CLOSED) clearTimeout(forceClose); });
      socket.on('message', (data, binary) => forward(upstream, bytes(data), binary));
      arm(Math.max(1, limits.lifetimeMs - (Date.now() - startedAt)), 1012, 'Reconnect media signaling');
      for (const frame of pending) forward(socket, frame.data, frame.binary);
      pending.length = 0; pendingBytes = 0;
    },
    close: () => stop(),
  };
}

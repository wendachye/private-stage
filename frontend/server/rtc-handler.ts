import type { upgradeWebSocket } from '@vercel/functions';
import { backendProxyConfig } from './backend-proxy-config.mjs';
import { connectSignalingBridge, SIGNAL_MAX_PAYLOAD, SignalingConnectionError, type SignalConnector, type SignalingBridgeOptions } from './signaling-bridge';

const failure = (status: number) => Response.json({ error: status === 403 ? 'Media admission denied.' : 'Media signaling unavailable.' },
  { status, headers: { 'Cache-Control': 'no-store' } });

/** The target is fixed deployment configuration; browser query parameters never choose an upstream. */
export async function handleRtcUpgrade(request: Request, upgrade: typeof upgradeWebSocket, options: {
  backend?: ReturnType<typeof backendProxyConfig>;
  connect?: SignalConnector;
  limits?: SignalingBridgeOptions['limits'];
} = {}) {
  const backend = options.backend ?? backendProxyConfig();
  if (!backend) return failure(404);
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(null, { status: 426, headers: { Upgrade: 'websocket', 'Cache-Control': 'no-store' } });
  }
  const original = new URL(request.url);
  if (original.pathname !== '/rtc') return failure(404);
  const target = new URL(backend.origin);
  target.protocol = 'wss:'; target.pathname = '/rtc'; target.search = original.search;
  const headers: Record<string, string> = { 'X-Stage-Proxy': backend.secret, 'X-Pinggy-No-Screen': '1' };
  // Preserve the browser's actual authority context. Never invent an allowed Origin.
  for (const key of ['origin', 'cookie', 'authorization']) {
    const value = request.headers.get(key);
    if (value) headers[key] = value;
  }
  let bridge: Awaited<ReturnType<typeof connectSignalingBridge>> | undefined;
  try {
    bridge = await connectSignalingBridge({ target, headers, signal: request.signal, connect: options.connect, limits: options.limits });
    return await upgrade(client => bridge!.attach(client), { maxPayload: SIGNAL_MAX_PAYLOAD });
  } catch (error) {
    bridge?.close();
    return failure(error instanceof SignalingConnectionError ? error.status : 502);
  }
}

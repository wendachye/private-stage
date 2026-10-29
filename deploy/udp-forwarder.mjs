import dgram from 'node:dgram';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const closeSocket = socket => new Promise(resolve => {
  try { socket.close(resolve); }
  catch (error) { if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve(); else throw error; }
});

/**
 * Forward UDP payloads unchanged, retaining an independent upstream socket for
 * each source address/port so return traffic reaches the correct remote peer.
 * @param {{listenHost?: string, listenPort: number, targetHost: string, targetPort: number, idleTimeoutMs?: number, maxPeers?: number}} options
 */
export async function createUdpForwarder({ listenHost = '127.0.0.1', listenPort, targetHost, targetPort,
  idleTimeoutMs = 120000, maxPeers = 256 }) {
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535
    || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535
    || !listenHost || !targetHost) throw new Error('UDP forwarding requires valid listen/target hosts and ports.');
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 50
    || !Number.isSafeInteger(maxPeers) || maxPeers < 1 || maxPeers > 65535) throw new Error('UDP forwarding requires bounded positive peer and idle limits.');
  const listener = dgram.createSocket('udp4');
  const peers = new Map();
  let closing;
  let sweep;
  const close = () => {
    clearInterval(sweep);
    return closing ??= Promise.all([closeSocket(listener), ...[...peers.values()].map(peer => closeSocket(peer.socket))]).then(() => { peers.clear(); });
  };
  const discard = (key, peer) => {
    if (peers.get(key) !== peer) return;
    peers.delete(key);
    void closeSocket(peer.socket);
  };
  listener.on('message', (message, remote) => {
    if (closing) return;
    const key = `${remote.address}:${remote.port}`;
    let peer = peers.get(key);
    if (!peer) {
      if (peers.size >= maxPeers) return;
      const socket = dgram.createSocket('udp4');
      peer = { socket, ready: false, pending: [], lastActive: Date.now() };
      peers.set(key, peer);
      const current = peer;
      socket.on('error', () => discard(key, current));
      socket.on('message', response => {
        if (!closing && peers.get(key) === current) {
          current.lastActive = Date.now();
          listener.send(response, remote.port, remote.address, () => {});
        }
      });
      socket.connect(targetPort, targetHost, () => {
        if (closing || peers.get(key) !== current) return;
        current.ready = true;
        for (const pending of current.pending) socket.send(pending, error => { if (error) discard(key, current); });
        current.pending = [];
      });
    }
    peer.lastActive = Date.now();
    if (peer.ready) peer.socket.send(message, error => { if (error) discard(key, peer); });
    else if (peer.pending.length < 8) peer.pending.push(message);
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.bind(listenPort, listenHost, () => { listener.off('error', reject); resolve(); });
  });
  listener.on('error', () => { void close(); });
  sweep = setInterval(() => {
    const oldest = Date.now() - idleTimeoutMs;
    for (const [key, peer] of peers) if (peer.lastActive <= oldest) discard(key, peer);
  }, Math.max(25, Math.min(1000, Math.floor(idleTimeoutMs / 2))));
  sweep.unref();
  return { address: listener.address(), close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  const forwarder = await createUdpForwarder({
    listenHost: process.env.UDP_LISTEN_HOST ?? '127.0.0.1',
    listenPort: Number(process.env.UDP_LISTEN_PORT ?? '7882'),
    targetHost: process.env.UDP_TARGET_HOST ?? 'livekit',
    targetPort: Number(process.env.UDP_TARGET_PORT),
    idleTimeoutMs: Number(process.env.UDP_IDLE_TIMEOUT_MS ?? '120000'),
    maxPeers: Number(process.env.UDP_MAX_PEERS ?? '256'),
  });
  console.log(`UDP forwarder ready on port ${forwarder.address.port}.`);
  const stop = () => { void forwarder.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

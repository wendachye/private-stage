import test from 'node:test';
import assert from 'node:assert/strict';
import dgram, { type Socket } from 'node:dgram';
import { once } from 'node:events';
import { createUdpForwarder } from '../deploy/udp-forwarder.mjs';

async function bound() {
  const socket = dgram.createSocket('udp4');
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  return socket;
}
const close = (socket: Socket) => new Promise<void>(done => socket.close(() => done()));
async function exchange(socket: Socket, port: number, data: Buffer, timeout = 1000) {
  const result = new Promise<Buffer>((done, reject) => {
    const receive = (message: Buffer) => { clearTimeout(timer); done(message); };
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('UDP reply timed out.')); }, timeout);
    socket.once('message', receive);
  });
  socket.send(data, port, '127.0.0.1');
  return result;
}

test('UDP forwarding preserves binary and empty datagrams while keeping simultaneous peers separate', async () => {
  const upstream = await bound(), first = await bound(), second = await bound();
  const seenPorts = new Set<number>();
  upstream.on('message', (message, peer) => {
    seenPorts.add(peer.port);
    setTimeout(() => upstream.send(message, peer.port, peer.address), message[0] === 1 ? 35 : 5);
  });
  const forwarder = await createUdpForwarder({ listenHost: '127.0.0.1', listenPort: 0,
    targetHost: '127.0.0.1', targetPort: upstream.address().port });
  try {
    const replies = await Promise.all([
      exchange(first, forwarder.address.port, Buffer.from([1, 0, 255, 128, 0])),
      exchange(second, forwarder.address.port, Buffer.from([2, 254, 0, 127])),
    ]);
    assert.deepEqual(replies[0], Buffer.from([1, 0, 255, 128, 0]));
    assert.deepEqual(replies[1], Buffer.from([2, 254, 0, 127]));
    assert.equal(seenPorts.size, 2, 'The upstream must distinguish the two client flows.');
    assert.equal((await exchange(first, forwarder.address.port, Buffer.alloc(0))).length, 0);
  } finally {
    await forwarder.close();
    await Promise.all([close(upstream), close(first), close(second)]);
  }
});

test('UDP forwarding bounds active peers and admits a new peer after the idle flow expires', async () => {
  const upstream = await bound(), first = await bound(), second = await bound();
  upstream.on('message', (message, peer) => upstream.send(message, peer.port, peer.address));
  const forwarder = await createUdpForwarder({ listenHost: '127.0.0.1', listenPort: 0,
    targetHost: '127.0.0.1', targetPort: upstream.address().port, maxPeers: 1, idleTimeoutMs: 200 });
  try {
    assert.equal((await exchange(first, forwarder.address.port, Buffer.from('first'))).toString(), 'first');
    await assert.rejects(exchange(second, forwarder.address.port, Buffer.from('blocked'), 70), /timed out/);
    await new Promise(done => setTimeout(done, 350));
    assert.equal((await exchange(second, forwarder.address.port, Buffer.from('after idle'))).toString(), 'after idle');
    await forwarder.close();
    await forwarder.close();
  } finally {
    await forwarder.close();
    await Promise.all([close(upstream), close(first), close(second)]);
  }
});

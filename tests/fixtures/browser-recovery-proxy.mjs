// Loopback-only browser regression fixture. Faults are controlled through a local
// JSON file, never an HTTP endpoint. It does not open or edit application data.
import { createServer, request as forward } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const upstream = new URL(process.env.RECOVERY_PROXY_UPSTREAM ?? 'http://localhost:3210');
if (upstream.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)) {
  throw new Error('Recovery fixture upstream must be loopback HTTP.');
}
if (!process.env.RECOVERY_PROXY_FAULT_FILE) throw new Error('Set RECOVERY_PROXY_FAULT_FILE to a local JSON file.');
const faultFile = resolve(process.env.RECOVERY_PROXY_FAULT_FILE);
const port = Number(process.env.RECOVERY_PROXY_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid fixture port.');
const sockets = new Set();
const headers = request => ({
  ...request.headers, host: upstream.host,
  ...(request.headers.origin ? { origin: upstream.origin } : {}),
});
const destination = request => {
  const url = new URL(request.url ?? '/', upstream);
  url.protocol = upstream.protocol; url.host = upstream.host;
  return url;
};
let lastFlags = {};
async function flags() {
  try {
    const parsed = JSON.parse(await readFile(faultFile, 'utf8'));
    lastFlags = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  catch (error) { if (error.code === 'ENOENT') lastFlags = {}; }
  return lastFlags;
}
function unavailable(response, status = 503) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: 'recovery-fixture-unavailable', message: 'Temporary connection failure for the local recovery test.' }));
}
const server = createServer(async (request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const fault = await flags();
  if (path === '/api/commands' && fault.commandVerificationUnavailable === true) {
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' });
    response.end(JSON.stringify({ error: 'verification-unavailable', message: 'Discord verification is temporarily unavailable. Please retry shortly.' })); return;
  }
  if ((path === '/api/bootstrap' && fault.bootstrap === true) || (path === '/api/state' && fault.state === true)) {
    unavailable(response); return;
  }
  if (path === '/api/events' && fault.accessEnded === true) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.end('event: access-ended\ndata: {}\n\n'); return;
  }
  const target = forward(destination(request), { method: request.method, headers: headers(request) }, result => {
    response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
  });
  target.on('error', () => { if (!response.headersSent) unavailable(response, 502); else response.destroy(); });
  request.on('aborted', () => target.destroy());
  response.on('close', () => { if (!response.writableEnded) target.destroy(); });
  request.pipe(target);
});
// Preserve the Next development/HMR WebSocket through the fixture as well.
server.on('upgrade', (request, socket, head) => {
  const target = forward(destination(request), { method: request.method, headers: headers(request) });
  target.on('upgrade', (response, remote, upstreamHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
    for (let i = 0; i < response.rawHeaders.length; i += 2) socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
    socket.write('\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) remote.write(head);
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    remote.on('close', () => socket.destroy()); socket.on('close', () => remote.destroy());
    socket.pipe(remote).pipe(socket);
  });
  target.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Proxy response\r\nConnection: close\r\n\r\n`); response.resume(); });
  target.on('error', () => socket.destroy()); target.end();
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
}
process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('disconnect', stop);
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ proxyUrl: `http://localhost:${server.address().port}`, pid: process.pid, faultFile }));
});

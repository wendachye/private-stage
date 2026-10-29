import { createServer } from 'node:http';
import { perform, control, closeFixture } from './workload.mjs';
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const value = request.url === '/api/health' ? { ready: true, backend: 'node:http baseline' } : request.url === '/api/control' ? await control(body) : request.url === '/api/bench' ? await perform(request.method, body) : undefined;
    response.writeHead(value ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value ?? { error: 'Not found' }));
  } catch (error) {
    response.writeHead(error.name === 'ZodError' ? 400 : error.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error.message }));
  }
});
const stop = () => server.close(() => { closeFixture(); process.exit(); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('BENCH_READY'));

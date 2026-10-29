import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiOrigin, apiUrl } from '../frontend/client/api-origin.ts';
import { request } from '../frontend/client/api.ts';

test('frontend API configuration accepts only a plain backend origin and keeps local same-origin paths valid', () => {
  assert.equal(normalizeApiOrigin(undefined), '');
  assert.equal(normalizeApiOrigin(''), '');
  assert.equal(normalizeApiOrigin('https://api.example.test/'), 'https://api.example.test');
  assert.equal(normalizeApiOrigin('http://localhost:3210'), 'http://localhost:3210');
  for (const value of ['javascript:alert(1)', 'https://user:secret@api.example.test', 'https://api.example.test/api', 'https://api.example.test/?token=x', 'https://api.example.test/#fragment']) {
    assert.throws(() => normalizeApiOrigin(value));
  }
  assert.equal(apiUrl('/api/state'), normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL) + '/api/state');
  assert.throws(() => apiUrl('//untrusted.example/api/state'));
  assert.throws(() => apiUrl('/\\untrusted.example/api/state'));
});

test('frontend API requests opt in to backend cookies while retaining command and cancellation headers', async () => {
  const original = globalThis.fetch;
  let observed: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => { observed = { url: String(input), init }; return Response.json({ ok: true }); };
  const cancellation = new AbortController();
  try {
    assert.deepEqual(await request('/api/commands', { type: 'room.leave' }, cancellation.signal), { ok: true });
    assert.equal(observed?.url, apiUrl('/api/commands'));
    assert.equal(observed?.init?.credentials, 'include');
    assert.equal(observed?.init?.method, 'POST');
    assert.equal(observed?.init?.signal, cancellation.signal);
    assert.equal(new Headers(observed?.init?.headers).get('X-Requested-With'), 'PrivateStage');
    assert.deepEqual(JSON.parse(String(observed?.init?.body)), { type: 'room.leave' });
  } finally { globalThis.fetch = original; }
});

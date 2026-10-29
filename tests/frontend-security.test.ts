import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { NextRequest } from 'next/server';
import { proxy } from '../frontend/proxy.ts';

test('frontend policy replaces caller-supplied nonce and CSP with a fresh matching hydration nonce', () => {
  const environment: Record<string, string | undefined> = process.env;
  const previous = environment.NODE_ENV;
  environment.NODE_ENV = 'production';
  try {
    const read = () => {
      const response = proxy(new NextRequest('https://app.example.test/', { headers: {
        'x-nonce': 'caller-controlled', 'Content-Security-Policy': "script-src 'unsafe-inline' 'nonce-caller-controlled'", } }));
      const csp = response.headers.get('content-security-policy') ?? '';
      const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
      assert.ok(nonce);
      assert.notEqual(nonce, 'caller-controlled');
      assert.equal(response.headers.get('x-middleware-request-x-nonce'), nonce);
      assert.equal(response.headers.get('x-middleware-request-content-security-policy'), csp);
      assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return nonce;
    };
    assert.notEqual(read(), read(), 'Two rendered frontend requests must not share a nonce.');
  } finally { if (previous === undefined) delete environment.NODE_ENV; else environment.NODE_ENV = previous; }
});

test('configured external API receives explicit HTTP and WebSocket policy entries without enabling arbitrary origins', async () => {
  const moduleUrl = new URL('../frontend/proxy.ts', import.meta.url).href;
  const code = `import {NextRequest} from 'next/server';import {proxy} from ${JSON.stringify(moduleUrl)};const r=proxy(new NextRequest('https://app.example.test/'));console.log(JSON.stringify({csp:r.headers.get('content-security-policy')}));`;
  const output = await new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.example.test' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += String(value));
    child.stderr.on('data', value => stderr += String(value));
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Frontend policy fixture timed out.')); }, 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? done(stdout) : reject(new Error(stderr || 'Frontend policy fixture failed.')); });
  });
  const { csp } = JSON.parse(output);
  const connections = String(csp).split(';').find(value => value.trim().startsWith('connect-src'))?.trim().split(/\s+/).slice(1) ?? [];
  assert.ok(connections.includes("'self'"));
  assert.ok(connections.includes('https://api.example.test'));
  assert.ok(connections.includes('wss://api.example.test'));
  assert.ok(connections.includes('wss://app.example.test'));
  for (const forbidden of ['*', 'https:', 'http:', 'ws:', 'wss:', 'https://untrusted.example']) assert.equal(connections.includes(forbidden), false);
});

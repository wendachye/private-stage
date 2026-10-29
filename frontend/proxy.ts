import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { apiOrigin } from './client/api-origin';
import { backendProxyConfig, isBackendPath } from './server/backend-proxy-config.mjs';

/** The frontend owns HTML policy in both combined and independent deployment. */
export function proxy(request: NextRequest) {
  if (isBackendPath(request.nextUrl.pathname)) {
    const backend = backendProxyConfig();
    if (!backend) return NextResponse.next();
    const headers = new Headers(request.headers);
    // Replace a caller's value; only the server controls origin authentication.
    headers.set('X-Stage-Proxy', backend.secret);
    headers.set('X-Pinggy-No-Screen', '1');
    const response = NextResponse.next({ request: { headers } });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('x-vercel-enable-rewrite-caching', '0');
    return response;
  }
  if (process.env.NODE_ENV !== 'production') return NextResponse.next();
  const nonce = randomBytes(16).toString('base64');
  const connect = ["'self'", request.nextUrl.origin.replace(/^http/, 'ws'), ...(apiOrigin ? [apiOrigin, apiOrigin.replace(/^http/, 'ws')] : [])];
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; connect-src ${[...new Set(connect)].join(' ')}; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  // Always replace caller headers: every rendered response gets a fresh nonce.
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (request.nextUrl.protocol === 'https:') response.headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  return response;
}

export const config = {
  matcher: ['/api/:path*', '/rtc/:path*', '/healthz', '/((?!api|rtc|healthz|_next/static|_next/image|favicon.ico).*)'],
};

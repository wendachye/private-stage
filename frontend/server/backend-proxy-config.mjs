const invalidOrigin = 'BACKEND_ORIGIN must be a plain HTTPS origin without credentials, paths, query or fragment.';

/**
 * Imported only by Next server configuration and its request proxy.
 * @param {Record<string, string | undefined>} environment
 */
export function backendProxyConfig(environment = process.env) {
  const configured = environment.BACKEND_ORIGIN?.trim();
  if (!configured) return undefined;
  let url;
  try { url = new URL(configured); }
  catch { throw new Error(invalidOrigin); }
  if (url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error(invalidOrigin);
  const secret = environment.BACKEND_PROXY_SECRET;
  if (!secret || secret.length < 32 || secret.length > 256 || /[^\x21-\x7e]/.test(secret)) {
    throw new Error('BACKEND_PROXY_SECRET must contain 32 to 256 printable non-space ASCII characters when BACKEND_ORIGIN is configured.');
  }
  return { origin: url.origin, secret };
}

export const backendPaths = ['/api/:path*', '/rtc/:path*', '/healthz'];
// The exact /rtc path belongs to the Vercel WebSocket function, not an HTTP rewrite.
export const backendRewritePaths = ['/api/:path*', '/rtc/:path+', '/healthz'];

/** @param {string} pathname */
export function isBackendPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/rtc' || pathname.startsWith('/rtc/') || pathname === '/healthz';
}

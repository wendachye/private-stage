/** Public API configuration only. Server credentials never belong here. */
export function normalizeApiOrigin(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return '';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('NEXT_PUBLIC_API_URL must be a plain HTTP(S) origin without credentials, paths, query or fragment.');
  }
  return url.origin;
}

export const apiOrigin = normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL);

export function apiUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('API paths must begin with a single slash and contain no backslashes.');
  return apiOrigin + path;
}

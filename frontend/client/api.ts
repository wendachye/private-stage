import type { Command, CommandResult, Principal, RoomSnapshot } from '../../shared/types';
import { apiUrl } from './api-origin';

export { apiUrl } from './api-origin';

export interface Bootstrap {
  appName: string;
  localPreview: boolean;
  configuration: { discordConfigured: boolean; mediaConfigured: boolean; missing: string[] };
  auth: { status: 'signed-out' | 'authenticated' | 'nonmember' | 'verification-unavailable'; user?: Principal; retryAt?: string };
  deviceId: string;
  csrfToken?: string;
}

let csrfToken: string | undefined;

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    signal,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'PrivateStage' }),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const nested = typeof payload.error === 'object' && payload.error ? payload.error as Record<string, unknown> : undefined;
    const message = String(payload.message ?? nested?.message ?? payload.error ?? `Request failed (${response.status})`);
    const retryHeader = response.headers.get('Retry-After');
    const delays = [retryHeader?.trim() ? Number(retryHeader) : NaN, payload.retryAfterSeconds].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    throw new ApiError(message, response.status, String(payload.code ?? nested?.code ?? (typeof payload.error === 'string' ? payload.error : '')), delays.length ? Math.ceil(Math.max(...delays)) : undefined);
  }
  return payload as T;
}

export async function bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
  const result = await request<Bootstrap>('/api/bootstrap', undefined, signal);
  csrfToken = result.csrfToken;
  return result;
}

export const getState = (signal?: AbortSignal) => request<RoomSnapshot>('/api/state', undefined, signal);
export const sendCommand = (command: Command) => request<CommandResult>('/api/commands', command);
export const getMediaToken = () => request<{ token: string; serverUrl: string }>('/api/media/token', {});
export const previewLogin = (persona: string) => request('/api/dev/login', { persona });
export const logout = () => request('/api/auth/logout', {});

export function klDate(value: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', ...options }).format(new Date(value));
}

export function klInput(value: string) {
  return new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export function klToInstant(value: string) {
  const instant = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(instant.getTime())) throw new Error('Enter a valid date and time in KL time.');
  return instant.toISOString();
}

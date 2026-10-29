import type { QueryClient } from '@tanstack/react-query';
import { ApiError, getState, type Bootstrap } from './api';
import type { RoomSnapshot } from '../../shared/types';

export const bootstrapKey = ['bootstrap'] as const;
export const roomKey = (boot: Bootstrap | null | undefined) => ['room', boot?.auth.user?.userId ?? 'anonymous', boot?.deviceId ?? 'unknown'] as const;

export async function readRoomState(boot: Bootstrap | null, signal?: AbortSignal) {
  const next = await getState(signal);
  if (next.self.userId !== boot?.auth.user?.userId || next.self.deviceId !== boot?.deviceId) {
    throw new ApiError('Your signed-in account changed. Reloading room access.', 401, 'session-changed');
  }
  return next;
}

export function accessFailure(reason: unknown, source: 'read' | 'command' = 'read'): Bootstrap['auth']['status'] | undefined {
  if (!(reason instanceof ApiError)) return undefined;
  // A strict command verification can be unavailable while the ordinary room
  // read still has usable membership. Let that read decide whether access ended.
  if (source === 'command' && reason.status === 503 && reason.code === 'verification-unavailable') return undefined;
  if (reason.code === 'nonmember') return 'nonmember';
  if (reason.code === 'verification-unavailable') return 'verification-unavailable';
  if (reason.status === 401) return 'signed-out';
  return undefined;
}

export function clearPrivateRoomCache(queries: QueryClient) {
  // Consuming the query's AbortSignal prevents a late HTTP response from repopulating it.
  void queries.cancelQueries({ queryKey: ['room'] });
  queries.removeQueries({ queryKey: ['room'] });
}

/** Invalidates responses from commands started before logout, account switch, or access loss. */
export class RoomAccessBoundary {
  private generation = 0;
  constructor(private readonly queries: QueryClient) {}
  capture() { return this.generation; }
  current(generation: number) { return generation === this.generation; }
  reset() {
    this.generation += 1;
    clearPrivateRoomCache(this.queries);
    return this.generation;
  }
  accept(generation: number, key: ReturnType<typeof roomKey>, snapshot: RoomSnapshot) {
    if (!this.current(generation) || snapshot.self.userId !== key[1] || snapshot.self.deviceId !== key[2]) return;
    this.queries.setQueryData<RoomSnapshot>(key, previous => !previous || snapshot.revision >= previous.revision ? snapshot : previous);
  }
}

type EventStream = Pick<EventSource, 'onopen' | 'onmessage' | 'onerror' | 'close'> & {
  addEventListener(type: string, listener: () => void): void;
};

/** An explicit access-ended event closes the stream instead of reconnecting with stale authority. */
export function watchRoomEvents(events: EventStream, callbacks: {
  connected: (value: boolean) => void;
  refresh: () => void;
  accessEnded: () => void;
}) {
  let closed = false;
  const refresh = () => { if (!closed) callbacks.refresh(); };
  events.onopen = () => { if (!closed) { callbacks.connected(true); refresh(); } };
  events.onmessage = refresh;
  events.onerror = () => { if (!closed) { callbacks.connected(false); refresh(); } };
  for (const event of ['state', 'change', 'invalidate']) events.addEventListener(event, refresh);
  events.addEventListener('access-ended', () => {
    if (closed) return;
    closed = true;
    events.close();
    callbacks.connected(false);
    callbacks.accessEnded();
  });
  return () => { closed = true; events.close(); };
}

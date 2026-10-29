import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Command, CommandResult, RoomSnapshot } from '../../shared/types';
import { apiUrl, ApiError, bootstrap, sendCommand, type Bootstrap } from './api';
import { accessFailure, bootstrapKey, clearPrivateRoomCache, readRoomState, RoomAccessBoundary, roomKey, watchRoomEvents } from './room-access';

export function useRoomModel() {
  const queries = useQueryClient();
  const [error, setError] = useState('');
  const [verificationRetryAt, setVerificationRetryAt] = useState<number>();
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [boundary] = useState(() => new RoomAccessBoundary(queries));
  const bootQuery = useQuery({ queryKey: bootstrapKey, queryFn: ({ signal }) => bootstrap(signal), staleTime: 30000 });
  const boot = bootQuery.data ?? null;
  const userId = boot?.auth.user?.userId;
  const deviceId = boot?.deviceId;
  const identity = useRef('');
  identity.current = `${userId ?? 'anonymous'}:${deviceId ?? 'unknown'}`;
  const authenticated = boot?.auth.status === 'authenticated' && !accessBlocked;
  const checkingAccess = useRef(false);
  const recoverAccess = useCallback((reason?: unknown) => {
    if (checkingAccess.current) return;
    checkingAccess.current = true;
    const generation = boundary.reset();
    setInitializing(false);
    setAccessBlocked(true);
    setConnected(false);
    setError(reason instanceof Error ? reason.message : 'Your room access ended. Sign in again if needed.');
    void queries.cancelQueries({ queryKey: bootstrapKey });
    queries.setQueryData<Bootstrap>(bootstrapKey, previous => previous ? { ...previous, auth: { status: accessFailure(reason) ?? 'signed-out' } } : previous);
    void queries.fetchQuery({ queryKey: bootstrapKey, queryFn: ({ signal }) => bootstrap(signal), staleTime: 0 })
      .then(() => { if (boundary.current(generation)) setAccessBlocked(false); })
      .catch(next => { if (boundary.current(generation)) setError(next instanceof Error ? next.message : 'Could not verify your access. Try again.'); })
      .finally(() => { checkingAccess.current = false; });
  }, [boundary, queries]);
  const stateQuery = useQuery({
    queryKey: roomKey(boot), queryFn: async ({ signal }) => {
      try { return await readRoomState(boot, signal); }
      catch (reason) { if (accessFailure(reason)) recoverAccess(reason); throw reason; }
    }, enabled: authenticated, staleTime: 5000,
    refetchInterval: authenticated ? connected ? 20000 : 5000 : false,
    structuralSharing: (oldData, newData) => {
      const previous = oldData as RoomSnapshot | undefined;
      const next = newData as RoomSnapshot;
      return previous && previous.revision > next.revision ? previous : next;
    },
  });
  useEffect(() => {
    const reason = bootQuery.error ?? stateQuery.error;
    if (reason) setError(reason instanceof Error ? reason.message : 'The room could not be reached.');
  }, [bootQuery.error, stateQuery.error]);
  useEffect(() => {
    if (boot && boot.auth.status !== 'authenticated') clearPrivateRoomCache(queries);
  }, [boot?.auth.status, queries]);
  const refresh = useCallback(async () => {
    await queries.invalidateQueries({ queryKey: ['room', userId ?? 'anonymous', deviceId ?? 'unknown'], refetchType: 'active' });
  }, [queries, userId, deviceId]);
  const initialize = useCallback(async () => {
    const generation = boundary.reset();
    setInitializing(true);
    setAccessBlocked(true);
    setConnected(false);
    setError('');
    await queries.cancelQueries({ queryKey: bootstrapKey });
    try {
      const next = await queries.fetchQuery({ queryKey: bootstrapKey, queryFn: ({ signal }) => bootstrap(signal), staleTime: 0 });
      if (!boundary.current(generation)) return;
      setAccessBlocked(false);
      if (next.auth.status === 'authenticated') await queries.fetchQuery({ queryKey: roomKey(next), queryFn: ({ signal }) => readRoomState(next, signal), staleTime: 0 });
    } catch (reason) {
      if (boundary.current(generation)) {
        if (accessFailure(reason)) recoverAccess(reason);
        else setError(reason instanceof Error ? reason.message : 'Could not reach the room. Try again.');
      }
      throw reason;
    } finally {
      if (boundary.current(generation)) setInitializing(false);
    }
  }, [boundary, queries, recoverAccess]);
  const reconnect = useCallback(() => {
    setStreamAttempt(previous => previous + 1);
    void refresh().catch(reason => setError(reason instanceof Error ? reason.message : 'Could not refresh the room.'));
  }, [refresh]);
  useEffect(() => {
    const up = () => { setOnline(true); reconnect(); };
    const down = () => { setOnline(false); setConnected(false); };
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, [reconnect]);
  useEffect(() => {
    if (!authenticated || !online) { setConnected(false); return; }
    const events = new EventSource(apiUrl('/api/events'), { withCredentials: true });
    return watchRoomEvents(events, { connected: setConnected,
      refresh: () => { void refresh().catch(() => undefined); }, accessEnded: () => recoverAccess() });
  }, [authenticated, userId, deviceId, online, streamAttempt, refresh, recoverAccess]);
  const mutation = useMutation({
    mutationKey: ['room-command'], mutationFn: (value: { command: Command; generation: number; key: ReturnType<typeof roomKey>; identity: string }) => sendCommand(value.command),
    onSuccess: (result, value) => {
      if (!boundary.current(value.generation) || identity.current !== value.identity) return;
      if (result.snapshot) boundary.accept(value.generation, value.key, result.snapshot);
      setError('');
      setVerificationRetryAt(undefined);
    },
    onError: (reason, value) => {
      if (!boundary.current(value.generation) || identity.current !== value.identity) return;
      if (reason instanceof ApiError && reason.code === 'verification-unavailable' && reason.retryAfterSeconds) setVerificationRetryAt(Date.now() + reason.retryAfterSeconds * 1000);
      if (accessFailure(reason, 'command')) recoverAccess(reason);
      else {
        setError(reason instanceof Error ? reason.message : 'That action could not be completed.');
        // A rejected fresh verification does not itself end an otherwise valid
        // session. Recheck the ordinary read now; it still clears expired access.
        if (reason instanceof ApiError && reason.status === 503 && reason.code === 'verification-unavailable') void refresh().catch(() => undefined);
      }
    },
  });
  const mutate = mutation.mutateAsync;
  const command = useCallback((value: Command): Promise<CommandResult> => {
    if (!authenticated) return Promise.reject(new ApiError('Verify your access before using room controls.', 401, 'signed-out'));
    if (!online) return Promise.reject(new Error('You’re offline. Reconnect before using room controls.'));
    return mutate({ command: value, generation: boundary.capture(), key: roomKey(boot), identity: identity.current });
  }, [authenticated, online, mutate, boundary, boot]);
  const busy = useIsMutating({ mutationKey: ['room-command'] }) > 0;
  return { boot, state: authenticated ? stateQuery.data ?? null : null,
    loading: bootQuery.isPending || (authenticated && stateQuery.isPending) || initializing,
    error, setError, verificationRetryAt, connected, online, busy, command, refresh, initialize, reconnect };
}

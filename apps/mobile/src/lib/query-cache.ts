import { useFocusEffect } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

/**
 * A small in-memory, stale-while-revalidate cache for Supabase reads, shared by every screen.
 *
 * - Screens show the cached value straight away instead of a spinner.
 * - On focus, a key is refetched only when it is older than its `staleTime`.
 * - Every hook using the same key shares one value and one in-flight request.
 * - `reload()` (pull-to-refresh, after a write, Realtime events) always refetches.
 * - `invalidateQueries()` marks keys stale after writes made outside the owning hook.
 *
 * Memory only, never persisted: cleared on sign-out / user change (see AuthProvider).
 */

export const MINUTE = 60_000;

type State<T> = { data: T | undefined; settled: boolean };

type Entry<T> = {
  state: State<T>;
  fetchedAt: number;
  promise: Promise<void> | null;
  /** A forced refetch was asked for while a request was already running. */
  again: boolean;
  fetcher: ((prev: T | undefined) => Promise<T>) | null;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry<unknown>>();
// Bumped by clearQueryCache so requests started for a previous user are dropped.
let epoch = 0;

const EMPTY: State<never> = { data: undefined, settled: false };

function entry<T>(key: string): Entry<T> {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { state: EMPTY, fetchedAt: 0, promise: null, again: false, fetcher: null, listeners: new Set() };
    entries.set(key, e as Entry<unknown>);
  }
  return e;
}

function run<T>(key: string, e: Entry<T>, force: boolean): Promise<void> {
  if (e.promise) {
    // A request that began before a write may return the old data: queue one more.
    if (force) e.again = true;
    return e.promise;
  }
  const fetcher = e.fetcher;
  if (!fetcher) return Promise.resolve();
  const started = epoch;
  const promise: Promise<void> = fetcher(e.state.data)
    .then(
      (data) => {
        if (started !== epoch) return;
        e.state = { data, settled: true };
        e.fetchedAt = Date.now();
      },
      (err) => {
        if (started !== epoch) return;
        console.warn(`Query ${key} failed`, err);
        if (!e.state.settled) e.state = { ...e.state, settled: true };
      },
    )
    .finally(() => {
      // Superseded by clearQueryCache: leave the newer request alone.
      if (e.promise !== promise) return;
      e.promise = null;
      e.listeners.forEach((l) => l());
      if (e.again) {
        e.again = false;
        void run(key, e, false);
      }
    });
  e.promise = promise;
  return promise;
}

/** Marks every key that starts with one of `prefixes` stale, refetching those on screen now. */
export function invalidateQueries(...prefixes: string[]) {
  for (const [key, e] of entries) {
    if (!prefixes.some((p) => key === p || key.startsWith(`${p}:`))) continue;
    e.fetchedAt = 0;
    if (e.listeners.size) void run(key, e, true);
  }
}

/** Drops everything (sign-out or a different user signing in). */
export function clearQueryCache() {
  epoch += 1;
  for (const [key, e] of entries) {
    if (!e.listeners.size) {
      entries.delete(key);
      continue;
    }
    // Still on screen: reset in place so subscribers stay attached, then let them refetch.
    e.state = EMPTY;
    e.fetchedAt = 0;
    e.promise = null;
    e.again = false;
    e.listeners.forEach((l) => l());
    void run(key, e, true);
  }
}

/**
 * Cached data for `key`, fetched with `fetcher` (which receives the previous value so it can
 * keep parts that failed to load). `key` null means "not ready" (e.g. no user yet).
 * `loading` is true until the first request settles; `data` stays undefined if it failed.
 */
export function useCachedQuery<T>(
  key: string | null,
  fetcher: (prev: T | undefined) => Promise<T>,
  { staleTime }: { staleTime: number },
) {
  // The latest fetcher, without making callers memoize it.
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key) return () => {};
      const e = entry<T>(key);
      e.listeners.add(onChange);
      return () => {
        e.listeners.delete(onChange);
      };
    },
    [key],
  );
  const state = useSyncExternalStore(subscribe, () => (key ? entry<T>(key).state : EMPTY) as State<T>);

  const fetchKey = useCallback(
    (force: boolean) => {
      if (!key) return Promise.resolve();
      const e = entry<T>(key);
      e.fetcher = (prev) => fetcherRef.current(prev);
      if (!force && e.state.settled && Date.now() - e.fetchedAt < staleTime) return Promise.resolve();
      return run(key, e, force);
    },
    [key, staleTime],
  );

  useFocusEffect(
    useCallback(() => {
      void fetchKey(false);
    }, [fetchKey]),
  );

  const reload = useCallback(() => fetchKey(true), [fetchKey]);

  return { data: state.data, loading: !state.settled, reload };
}

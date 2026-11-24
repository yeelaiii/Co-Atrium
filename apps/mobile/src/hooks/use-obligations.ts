import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { Obligation, ProjectEvent } from '@/lib/deadlines';
import { useCachedQuery } from '@/lib/query-cache';
import { channelName } from '@/lib/realtime';
import { supabase } from '@/lib/supabase';

export type DeadlineGroups = {
  overdue: Obligation[];
  suggested: Obligation[];
  thisWeek: Obligation[];
  later: Obligation[];
  closed: Obligation[];
};

const WEEK_MS = 7 * 86_400_000;

type ObligationsData = { obligations: Obligation[]; events: ProjectEvent[]; failed: boolean; loadedAt: number };
const EMPTY_OBLIGATIONS: Obligation[] = [];
const EMPTY_EVENTS: ProjectEvent[] = [];

/** Cache key of a project's obligations and events; invalidate it after logging an event. */
export const obligationsKey = (projectId: string) => `project:${projectId}:obligations`;

/** Obligations and events of a project, live through Realtime, grouped for the dashboard. */
export function useObligations(projectId: string) {
  const { data, loading, reload } = useCachedQuery<ObligationsData>(
    obligationsKey(projectId),
    async (prev) => {
      const [o, e] = await Promise.all([
        supabase.from('obligations').select('*').eq('project_id', projectId).order('due_at'),
        supabase.from('project_events').select('*').eq('project_id', projectId).is('voided_at', null).order('sent_at', { ascending: false }).limit(300),
      ]);
      return {
        obligations: o.error ? (prev?.obligations ?? EMPTY_OBLIGATIONS) : ((o.data ?? []) as Obligation[]),
        events: e.error ? (prev?.events ?? EMPTY_EVENTS) : ((e.data ?? []) as ProjectEvent[]),
        failed: !!(o.error || e.error),
        loadedAt: Date.now(),
      };
    },
    // Realtime keeps it current while a screen is open; this only covers time spent elsewhere.
    { staleTime: 30_000 },
  );
  const obligations = data?.obligations ?? EMPTY_OBLIGATIONS;
  const events = data?.events ?? EMPTY_EVENTS;
  const failed = data?.failed ?? false;
  // "This week" is relative to the last load, not to each render.
  const loadedAt = data?.loadedAt ?? 0;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, 300);
    };
    const channel = supabase
      .channel(channelName(`obligations:${projectId}`))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'obligations', filter: `project_id=eq.${projectId}` }, later)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [projectId, reload]);

  const groups = useMemo<DeadlineGroups>(() => {
    const now = loadedAt;
    const g: DeadlineGroups = { overdue: [], suggested: [], thisWeek: [], later: [], closed: [] };
    for (const o of obligations) {
      if (o.status === 'overdue') g.overdue.push(o);
      else if (o.status === 'suggested') g.suggested.push(o);
      else if (o.status === 'open') (new Date(o.due_at).getTime() - now < WEEK_MS ? g.thisWeek : g.later).push(o);
      else g.closed.push(o);
    }
    g.closed.sort((a, b) => (b.closed_at ?? b.due_at).localeCompare(a.closed_at ?? a.due_at));
    return g;
  }, [obligations, loadedAt]);

  const eventsById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  const act = useCallback(
    async (fn: string, args: Record<string, unknown>) => {
      const { error } = await supabase.rpc(fn, args);
      await reload();
      return error;
    },
    [reload],
  );

  return {
    obligations,
    events,
    eventsById,
    groups,
    loading,
    failed,
    reload,
    markMet: (oid: string, note?: string) => act('mark_obligation_met', { oid, note: note ?? null }),
    confirmSuggested: (oid: string) => act('confirm_suggested_obligation', { oid }),
    waive: (oid: string, note: string) => act('waive_obligation', { oid, note }),
    voidEvent: (eid: string) => act('void_project_event', { eid }),
  };
}

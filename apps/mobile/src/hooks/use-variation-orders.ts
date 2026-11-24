import { useEffect, useMemo, useRef } from 'react';

import { useCachedQuery } from '@/lib/query-cache';
import { channelName } from '@/lib/realtime';
import { supabase } from '@/lib/supabase';
import { mapVoRow, sortVariationOrders, voBucket, voQuery, type VariationOrder } from '@/lib/variation-orders';
import { useAuth } from '@/providers/AuthProvider';

const EMPTY: VariationOrder[] = [];

/**
 * Every VO in a project, sorted for display (bucket order, newest first), kept live through
 * Realtime: new VOs and approvals show up without a pull-to-refresh.
 */
export function useVariationOrders(projectId: string) {
  const { session } = useAuth();
  const me = session?.user.id;
  const { data, loading, reload } = useCachedQuery<{ rows: VariationOrder[]; failed: boolean }>(
    `project:${projectId}:vos`,
    async (prev) => {
      const { data, error } = await voQuery().eq('project_id', projectId).order('sent_at', { ascending: false });
      if (error) return { rows: prev?.rows ?? EMPTY, failed: true };
      return { rows: (data ?? []).map((r) => mapVoRow(r as never)), failed: false };
    },
    // Realtime keeps it current while a screen is open; this only covers time spent elsewhere.
    { staleTime: 30_000 },
  );
  const rows = data?.rows ?? EMPTY;
  const failed = data?.failed ?? false;

  // Bursts of changes (a VO and its approvers arrive together) collapse into one refetch.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, 300);
    };
    const filter = `project_id=eq.${projectId}`;
    const channel = supabase
      .channel(channelName(`vos:${projectId}`))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_orders', filter }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_order_approvers', filter }, later)
      // Being included in a VO is what makes it appear for someone.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_order_participants', filter }, later)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [projectId, reload]);

  const variationOrders = useMemo(() => sortVariationOrders(rows, me), [rows, me]);
  const awaitingMe = useMemo(() => rows.filter((vo) => voBucket(vo, me) === 'yours').length, [rows, me]);

  return { variationOrders, awaitingMe, loading, failed, reload };
}

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { mapVoRow, sortVariationOrders, voBucket, voQuery, type VariationOrder } from '@/lib/variation-orders';
import { useAuth } from '@/providers/AuthProvider';

/**
 * Every VO in a project, sorted for display (bucket order, newest first), kept live through
 * Realtime: new VOs and approvals show up without a pull-to-refresh.
 */
export function useVariationOrders(projectId: string) {
  const { session } = useAuth();
  const me = session?.user.id;
  const [rows, setRows] = useState<VariationOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const { data, error } = await voQuery().eq('project_id', projectId).order('sent_at', { ascending: false });
    setFailed(!!error);
    if (!error) setRows((data ?? []).map((r) => mapVoRow(r as never)));
    setLoading(false);
  }, [projectId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  // Bursts of changes (a VO and its approvers arrive together) collapse into one refetch.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, 300);
    };
    const filter = `project_id=eq.${projectId}`;
    const channel = supabase
      .channel(`vos:${projectId}`)
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

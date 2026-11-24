import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Obligation, ProjectEvent } from '@/lib/deadlines';
import { channelName } from '@/lib/realtime';
import { supabase } from '@/lib/supabase';
import { mapVoRow, voQuery, type VariationOrder } from '@/lib/variation-orders';
import type { VoHistoryEntry } from '@/lib/vo-contract';

/**
 * One VO's contractual side: the VO, events logged against it (timeline), the history of its
 * status and amounts, its deadlines and the payment claims it was included in. Kept live.
 * Events, deadlines and payment claims are only readable by owners/members (RLS); guests see
 * the amounts and history only.
 */
export function useVoContract(voId: string) {
  const [vo, setVo] = useState<VariationOrder | null>(null);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [history, setHistory] = useState<VoHistoryEntry[]>([]);
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [paymentClaims, setPaymentClaims] = useState<ProjectEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const [v, e, h, o, pc] = await Promise.all([
      voQuery().eq('id', voId).maybeSingle(),
      supabase.from('project_events').select('*').eq('variation_order_id', voId).order('sent_at'),
      supabase
        .from('variation_amount_history')
        .select('id, field, old_value, new_value, source_event_id, note, changed_by, changed_at, changer:profiles!changed_by(display_name)')
        .eq('variation_order_id', voId)
        .order('id'),
      supabase.from('obligations').select('*').eq('variation_order_id', voId).order('due_at'),
      supabase.from('variation_payment_claims').select('event:project_events!event_id(*)').eq('variation_order_id', voId),
    ]);
    setFailed(!!(v.error || h.error));
    if (!v.error) setVo(v.data ? mapVoRow(v.data as never) : null);
    if (!e.error) setEvents((e.data ?? []) as ProjectEvent[]);
    if (!h.error) setHistory((h.data ?? []) as unknown as VoHistoryEntry[]);
    if (!o.error) setObligations((o.data ?? []) as Obligation[]);
    if (!pc.error) {
      setPaymentClaims(
        ((pc.data ?? []) as unknown as { event: ProjectEvent | null }[])
          .map((r) => r.event)
          .filter((x): x is ProjectEvent => !!x && !x.voided_at)
          .sort((a, b) => a.sent_at.localeCompare(b.sent_at)),
      );
    }
    setLoading(false);
  }, [voId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, 300);
    };
    const channel = supabase
      .channel(channelName(`vo-contract:${voId}`))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'variation_orders', filter: `id=eq.${voId}` }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'obligations', filter: `variation_order_id=eq.${voId}` }, later)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [voId, reload]);

  return { vo, events, history, obligations, paymentClaims, loading, failed, reload };
}

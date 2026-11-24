import { useEffect, useRef } from 'react';

import type { Obligation, ProjectEvent } from '@/lib/deadlines';
import { useCachedQuery } from '@/lib/query-cache';
import { channelName } from '@/lib/realtime';
import { supabase } from '@/lib/supabase';
import { mapVoRow, voQuery, type VariationOrder } from '@/lib/variation-orders';
import type { VoHistoryEntry } from '@/lib/vo-contract';

type VoContractData = {
  vo: VariationOrder | null;
  events: ProjectEvent[];
  history: VoHistoryEntry[];
  obligations: Obligation[];
  paymentClaims: ProjectEvent[];
  failed: boolean;
};
const EMPTY_EVENTS: ProjectEvent[] = [];
const EMPTY_HISTORY: VoHistoryEntry[] = [];
const EMPTY_OBLIGATIONS: Obligation[] = [];

/**
 * One VO's contractual side: the VO, events logged against it (timeline), the history of its
 * status and amounts, its deadlines and the payment claims it was included in. Kept live.
 * Events, deadlines and payment claims are only readable by owners/members (RLS); guests see
 * the amounts and history only.
 */
export function useVoContract(voId: string) {
  const { data, loading, reload } = useCachedQuery<VoContractData>(
    `vo:${voId}:contract`,
    async (prev) => {
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
      return {
        vo: v.error ? (prev?.vo ?? null) : v.data ? mapVoRow(v.data as never) : null,
        events: e.error ? (prev?.events ?? EMPTY_EVENTS) : ((e.data ?? []) as ProjectEvent[]),
        history: h.error ? (prev?.history ?? EMPTY_HISTORY) : ((h.data ?? []) as unknown as VoHistoryEntry[]),
        obligations: o.error ? (prev?.obligations ?? EMPTY_OBLIGATIONS) : ((o.data ?? []) as Obligation[]),
        paymentClaims: pc.error
          ? (prev?.paymentClaims ?? EMPTY_EVENTS)
          : ((pc.data ?? []) as unknown as { event: ProjectEvent | null }[])
              .map((r) => r.event)
              .filter((x): x is ProjectEvent => !!x && !x.voided_at)
              .sort((a, b) => a.sent_at.localeCompare(b.sent_at)),
        failed: !!(v.error || h.error),
      };
    },
    // Events and history have no Realtime feed: revalidate on every visit, showing the last copy meanwhile.
    { staleTime: 0 },
  );
  const vo = data?.vo ?? null;
  const events = data?.events ?? EMPTY_EVENTS;
  const history = data?.history ?? EMPTY_HISTORY;
  const obligations = data?.obligations ?? EMPTY_OBLIGATIONS;
  const paymentClaims = data?.paymentClaims ?? EMPTY_EVENTS;
  const failed = data?.failed ?? false;

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

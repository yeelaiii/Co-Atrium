import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { supabase } from '@/lib/supabase';

/** Payment claim references (e.g. "PC-07") per VO, for the VOs and claims the user can see. */
export function usePaymentClaimRefs(projectId: string) {
  const [refs, setRefs] = useState<Map<string, string[]>>(new Map());
  useFocusEffect(
    useCallback(() => {
      let live = true;
      supabase
        .from('variation_payment_claims')
        .select('variation_order_id, event:project_events!event_id(reference, sent_at, voided_at)')
        .eq('project_id', projectId)
        .then(({ data }) => {
          if (!live) return;
          const map = new Map<string, string[]>();
          type Row = { variation_order_id: string; event: { reference: string | null; sent_at: string; voided_at: string | null } | null };
          for (const r of (data ?? []) as unknown as Row[]) {
            if (!r.event || r.event.voided_at) continue;
            map.set(r.variation_order_id, [...(map.get(r.variation_order_id) ?? []), r.event.reference ?? r.event.sent_at.slice(0, 10)]);
          }
          setRefs(map);
        });
      return () => {
        live = false;
      };
    }, [projectId]),
  );
  return refs;
}

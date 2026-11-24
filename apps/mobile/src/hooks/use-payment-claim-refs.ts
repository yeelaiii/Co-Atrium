import { MINUTE, useCachedQuery } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';

type Row = { variation_order_id: string; event: { reference: string | null; sent_at: string; voided_at: string | null } | null };

const EMPTY = new Map<string, string[]>();

/** Payment claim references (e.g. "PC-07") per VO, for the VOs and claims the user can see. */
export function usePaymentClaimRefs(projectId: string) {
  const { data } = useCachedQuery<Map<string, string[]>>(
    `project:${projectId}:claim-refs`,
    async (prev) => {
      const { data, error } = await supabase
        .from('variation_payment_claims')
        .select('variation_order_id, event:project_events!event_id(reference, sent_at, voided_at)')
        .eq('project_id', projectId);
      if (error) return prev ?? EMPTY;
      const map = new Map<string, string[]>();
      for (const r of (data ?? []) as unknown as Row[]) {
        if (!r.event || r.event.voided_at) continue;
        map.set(r.variation_order_id, [...(map.get(r.variation_order_id) ?? []), r.event.reference ?? r.event.sent_at.slice(0, 10)]);
      }
      return map;
    },
    { staleTime: MINUTE },
  );
  return data ?? EMPTY;
}

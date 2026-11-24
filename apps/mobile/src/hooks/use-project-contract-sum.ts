import { fetchProjectContractSum, type ProjectContractSum } from '@/lib/vo-contract';
import { MINUTE, useCachedQuery } from '@/lib/query-cache';

/**
 * Cache key of the server-side contract sum. It sits under `project:<id>:contract`, so contract
 * field edits and document uploads (which invalidate that prefix) refresh it too.
 */
export const contractSumKey = (projectId: string) => `project:${projectId}:contract:sum`;

/**
 * Server totals over every VO in the project (contract roles only: pass `enabled` false for
 * everyone else and nothing is fetched). Refreshed when VOs change (Realtime in
 * useVariationOrders, VO contract updates) or on pull-to-refresh, not on every screen focus.
 */
export function useProjectContractSum(projectId: string, enabled: boolean) {
  const { data, reload } = useCachedQuery<ProjectContractSum | null>(
    enabled ? contractSumKey(projectId) : null,
    (prev) => fetchProjectContractSum(projectId).then((sum) => sum ?? prev ?? null),
    { staleTime: 10 * MINUTE },
  );
  return { projectSum: enabled ? (data ?? null) : null, reload };
}

import type { Party } from '@shared/deadlines/rules.ts';

import type { JobRole, MemberRole } from '@/lib/projects';
import { MINUTE, useCachedQuery } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type MyMembership = { role: MemberRole; job_role: JobRole | null; contract_party: Party | null };

/**
 * The signed-in user's own membership row in a project (null while loading / if not a member).
 * One cached request shared by useMyRole and useContract. The key sits under `project:<id>:role`,
 * which useProjectMembers invalidates whenever a role or contract party changes.
 */
export function useMyMembership(projectId: string) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const { data, loading, reload } = useCachedQuery<MyMembership | null>(
    userId ? `project:${projectId}:role:${userId}:membership` : null,
    async (prev) => {
      const { data, error } = await supabase
        .from('project_members')
        .select('role, job_role, contract_party')
        .eq('project_id', projectId)
        .eq('user_id', userId!)
        .is('left_at', null)
        .maybeSingle();
      return error ? (prev ?? null) : ((data as MyMembership | null) ?? null);
    },
    { staleTime: 15 * MINUTE },
  );
  return { membership: data ?? null, loading, reload };
}

/** The signed-in user's role in a project, or null while loading / if not a member. */
export function useMyRole(projectId: string) {
  const role = useMyMembership(projectId).membership?.role ?? null;
  /** Owners and members write in VO threads; guests and viewers read only (migration 0014). */
  return { role, canWrite: role === 'owner' || role === 'member' };
}

import type { MemberRole } from '@/lib/projects';
import { MINUTE, useCachedQuery } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

/** The signed-in user's role in a project, or null while loading / if not a member. */
export function useMyRole(projectId: string) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const { data: role = null } = useCachedQuery<MemberRole | null>(
    userId ? `project:${projectId}:role:${userId}` : null,
    async (prev) => {
      const { data, error } = await supabase
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', userId!)
        .is('left_at', null)
        .maybeSingle();
      return error ? (prev ?? null) : ((data?.role as MemberRole | undefined) ?? null);
    },
    { staleTime: 5 * MINUTE },
  );

  /** Owners and members write in VO threads; guests and viewers read only (migration 0014). */
  return { role, canWrite: role === 'owner' || role === 'member' };
}

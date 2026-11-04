import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { MemberRole } from '@/lib/projects';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

/** The signed-in user's role in a project, or null while loading / if not a member. */
export function useMyRole(projectId: string) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [role, setRole] = useState<MemberRole | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      supabase
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .is('left_at', null)
        .maybeSingle()
        .then(({ data }) => setRole((data?.role as MemberRole | undefined) ?? null));
    }, [projectId, userId]),
  );

  /** Owners and members write in VO threads; guests and viewers read only (migration 0014). */
  return { role, canWrite: role === 'owner' || role === 'member' };
}

import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { MemberRole } from '@/lib/projects';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type ProjectSummary = { id: string; name: string; role: MemberRole };

/** Projects the signed-in user is an active member of, with their role in each. */
export function useProjects() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from('project_members')
      .select('role, projects!inner(id, name, deleted_at)')
      .eq('user_id', userId)
      .is('left_at', null)
      .is('projects.deleted_at', null);
    setFailed(!!error);
    if (!error) {
      const rows = (data ?? []) as unknown as { role: MemberRole; projects: { id: string; name: string } }[];
      setProjects(
        rows
          .map((row) => ({ id: row.projects.id, name: row.projects.name, role: row.role }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
    setLoading(false);
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  return { projects, loading, failed, reload };
}

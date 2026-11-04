import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { MemberRole, ProjectStatus } from '@/lib/projects';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type ProjectSummary = {
  id: string;
  name: string;
  role: MemberRole;
  status: ProjectStatus;
  location: string | null;
  clientName: string | null;
};

type Row = {
  role: MemberRole;
  projects: { id: string; name: string; status: ProjectStatus; location: string | null; client_name: string | null };
};

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
      .select('role, projects!inner(id, name, status, location, client_name, deleted_at)')
      .eq('user_id', userId)
      .is('left_at', null)
      .is('projects.deleted_at', null);
    setFailed(!!error);
    if (!error) {
      const rows = (data ?? []) as unknown as Row[];
      setProjects(
        rows
          .map(({ role, projects: p }) => ({
            id: p.id,
            name: p.name,
            role,
            status: p.status,
            location: p.location,
            clientName: p.client_name,
          }))
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

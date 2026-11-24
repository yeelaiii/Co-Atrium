import type { MemberRole, ProjectStatus } from '@/lib/projects';
import { MINUTE, useCachedQuery } from '@/lib/query-cache';
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

/** Cache key prefix for the projects list; invalidate it after creating or joining a project. */
export const PROJECTS_KEY = 'projects';

/** Projects the signed-in user is an active member of, with their role in each. */
export function useProjects() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const { data, loading, reload } = useCachedQuery<{ projects: ProjectSummary[]; failed: boolean }>(
    userId ? `${PROJECTS_KEY}:${userId}` : null,
    async (prev) => {
      const { data, error } = await supabase
        .from('project_members')
        .select('role, projects!inner(id, name, status, location, client_name, deleted_at)')
        .eq('user_id', userId!)
        .is('left_at', null)
        .is('projects.deleted_at', null);
      if (error) return { projects: prev?.projects ?? [], failed: true };
      const rows = (data ?? []) as unknown as Row[];
      return {
        projects: rows
          .map(({ role, projects: p }) => ({
            id: p.id,
            name: p.name,
            role,
            status: p.status,
            location: p.location,
            clientName: p.client_name,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        failed: false,
      };
    },
    // Invalidated after creating/joining a project; the Projects screen has pull-to-refresh.
    { staleTime: 10 * MINUTE },
  );
  return { projects: data?.projects ?? EMPTY, loading, failed: data?.failed ?? false, reload };
}

const EMPTY: ProjectSummary[] = [];

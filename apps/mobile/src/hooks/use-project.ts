import type { ProjectStatus } from '@/lib/projects';
import { MINUTE, useCachedQuery } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';

export type ProjectDetails = {
  id: string;
  name: string;
  status: ProjectStatus;
  location: string | null;
  projectType: string | null;
  clientName: string | null;
  description: string | null;
};

/** One project's details, cached for a few minutes. RLS only returns it to active members. */
export function useProject(projectId: string) {
  const { data, loading, reload } = useCachedQuery<{ project: ProjectDetails | null; failed: boolean }>(
    `project:${projectId}:details`,
    async (prev) => {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, status, location, project_type, client_name, description')
        .eq('id', projectId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error || !data) return { project: prev?.project ?? null, failed: true };
      return {
        project: {
          id: data.id,
          name: data.name,
          status: data.status as ProjectStatus,
          location: data.location,
          projectType: data.project_type,
          clientName: data.client_name,
          description: data.description,
        },
        failed: false,
      };
    },
    { staleTime: 5 * MINUTE },
  );
  return { project: data?.project ?? null, loading, failed: data?.failed ?? false, reload };
}

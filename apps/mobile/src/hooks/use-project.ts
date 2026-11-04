import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { ProjectStatus } from '@/lib/projects';
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

/** One project's details. RLS only returns it to active members. */
export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, status, location, project_type, client_name, description')
      .eq('id', projectId)
      .is('deleted_at', null)
      .maybeSingle();
    setFailed(!!error || !data);
    if (!error && data) {
      setProject({
        id: data.id,
        name: data.name,
        status: data.status as ProjectStatus,
        location: data.location,
        projectType: data.project_type,
        clientName: data.client_name,
        description: data.description,
      });
    }
    setLoading(false);
  }, [projectId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  return { project, loading, failed, reload };
}

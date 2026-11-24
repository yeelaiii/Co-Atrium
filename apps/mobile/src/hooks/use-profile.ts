import { supabase } from '@/lib/supabase';
import { MINUTE, useCachedQuery } from '@/lib/query-cache';
import { useAuth } from '@/providers/AuthProvider';

export type Profile = { display_name: string | null; company_name: string | null };

/**
 * The signed-in user's profile row, cached for a few minutes. `reload` refetches (e.g. after
 * an edit) and every screen showing the profile picks up the new value.
 */
export function useProfile() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const { data, loading, reload } = useCachedQuery<Profile | null>(
    userId ? `profile:${userId}` : null,
    async (prev) => {
      const { data, error } = await supabase.from('profiles').select('display_name, company_name').eq('id', userId!).single();
      return error ? (prev ?? null) : data;
    },
    { staleTime: 5 * MINUTE },
  );
  return { profile: data ?? null, loading, reload };
}

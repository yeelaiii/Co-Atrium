import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type Profile = { display_name: string | null; company_name: string | null; job_role: string | null };

/** The signed-in user's profile row. `reload` refetches (e.g. after an edit). */
export function useProfile() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from('profiles')
      .select('display_name, company_name, job_role')
      .eq('id', userId)
      .single();
    setProfile(data);
    setLoading(false);
  }, [userId]);

  // Refetch whenever the screen gains focus, so edits made on the Profile tab show up on Home.
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  return { profile, loading, reload };
}

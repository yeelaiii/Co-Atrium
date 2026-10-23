import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { MemberRole } from '@/lib/projects';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type Member = {
  user_id: string;
  role: MemberRole;
  display_name: string | null;
  company_name: string | null;
  job_role: string | null;
};
export type PendingInvite = { invite_id: string; email: string; role: string; expires_at: string };

/** Roster and (for owners) pending invites of one project, plus the owner actions on them. */
export function useProjectMembers(projectId: string) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [members, setMembers] = useState<Member[]>([]);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const myRole = members.find((m) => m.user_id === userId)?.role ?? null;
  const isOwner = myRole === 'owner';

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('project_members')
      .select('user_id, role, profiles(display_name, company_name, job_role)')
      .eq('project_id', projectId)
      .is('left_at', null);
    setFailed(!!error);
    if (error) {
      setLoading(false);
      return;
    }
    const rows = (data ?? []) as unknown as (Pick<Member, 'user_id' | 'role'> & {
      profiles: Pick<Member, 'display_name' | 'company_name' | 'job_role'> | null;
    })[];
    const list = rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      display_name: r.profiles?.display_name ?? null,
      company_name: r.profiles?.company_name ?? null,
      job_role: r.profiles?.job_role ?? null,
    }));
    setMembers(list);

    // Only owners may list invites; the RPC rejects everyone else.
    if (list.find((m) => m.user_id === userId)?.role === 'owner') {
      const res = await supabase.rpc('project_pending_invites', { pid: projectId });
      if (!res.error) setPending((res.data ?? []) as PendingInvite[]);
    } else {
      setPending([]);
    }
    setLoading(false);
  }, [projectId, userId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  /** Each action resolves to true on success. */
  const act = useCallback(
    async (run: () => PromiseLike<{ error: unknown }>) => {
      const { error } = await run();
      await reload();
      return !error;
    },
    [reload],
  );

  const setRole = (uid: string, role: string) =>
    act(() => supabase.rpc('set_member_role', { pid: projectId, uid, new_role: role }));
  const remove = (uid: string) => act(() => supabase.rpc('remove_member', { pid: projectId, uid }));
  const revoke = (inviteId: string) => act(() => supabase.rpc('revoke_invite', { invite_id: inviteId }));

  return { members, pending, loading, failed, isOwner, myRole, reload, setRole, remove, revoke };
}

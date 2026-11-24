import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { Party } from '@shared/deadlines/index.ts';

import type { ContractRole } from '@/lib/deadlines';
import type { JobRole, MemberRole } from '@/lib/projects';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type Member = {
  user_id: string;
  role: MemberRole;
  display_name: string | null;
  company_name: string | null;
  /** Profession on this project (set by owners). Reference only. */
  job_role: JobRole | null;
  /** Lets them confirm contract values and verify deadline rules (owner/member only). */
  contract_role: ContractRole | null;
  /** Which side of the contract they act for: decides who gets which reminders. */
  contract_party: Party | null;
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
      .select('user_id, role, job_role, contract_role, contract_party, profiles(display_name, company_name)')
      .eq('project_id', projectId)
      .is('left_at', null);
    setFailed(!!error);
    if (error) {
      setLoading(false);
      return;
    }
    const rows = (data ?? []) as unknown as (Pick<Member, 'user_id' | 'role' | 'job_role' | 'contract_role' | 'contract_party'> & {
      profiles: Pick<Member, 'display_name' | 'company_name'> | null;
    })[];
    const list = rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      display_name: r.profiles?.display_name ?? null,
      company_name: r.profiles?.company_name ?? null,
      job_role: r.job_role ?? null,
      contract_role: r.contract_role ?? null,
      contract_party: r.contract_party ?? null,
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
  const setJobRole = (uid: string, jobRole: JobRole | null) =>
    act(() => supabase.rpc('set_member_job_role', { pid: projectId, uid, new_job_role: jobRole }));
  const setContractProfile = (uid: string, contractRole: ContractRole | null, contractParty: Party | null) =>
    act(() =>
      supabase.rpc('set_member_contract_profile', {
        pid: projectId,
        uid,
        new_contract_role: contractRole,
        new_contract_party: contractParty,
      }),
    );
  const remove = (uid: string) => act(() => supabase.rpc('remove_member', { pid: projectId, uid }));
  const revoke = (inviteId: string) => act(() => supabase.rpc('revoke_invite', { invite_id: inviteId }));

  return { members, pending, loading, failed, isOwner, myRole, reload, setRole, setJobRole, setContractProfile, remove, revoke };
}

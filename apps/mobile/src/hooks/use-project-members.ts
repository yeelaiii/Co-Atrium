import { useCallback } from 'react';

import type { Party } from '@shared/deadlines/index.ts';

import type { JobRole, MemberRole } from '@/lib/projects';
import { invalidateQueries, MINUTE, useCachedQuery } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type Member = {
  user_id: string;
  role: MemberRole;
  display_name: string | null;
  company_name: string | null;
  /** Role on this project (set by owners). Confirming roles can confirm contract values (owner/member only). */
  job_role: JobRole | null;
  /** Which side of the contract they act for: decides who gets which reminders. */
  contract_party: Party | null;
};
export type PendingInvite = { invite_id: string; email: string; role: string; expires_at: string };

type MembersData = { members: Member[]; pending: PendingInvite[]; failed: boolean };
const EMPTY_MEMBERS: Member[] = [];
const EMPTY_PENDING: PendingInvite[] = [];

/** Roster and (for owners) pending invites of one project, plus the owner actions on them. */
export function useProjectMembers(projectId: string) {
  const { session } = useAuth();
  const userId = session?.user.id;

  const { data, loading, reload } = useCachedQuery<MembersData>(
    userId ? `project:${projectId}:members:${userId}` : null,
    async (prev) => {
      const { data, error } = await supabase
        .from('project_members')
        .select('user_id, role, job_role, contract_party, profiles(display_name, company_name)')
        .eq('project_id', projectId)
        .is('left_at', null);
      if (error) return { members: prev?.members ?? [], pending: prev?.pending ?? [], failed: true };
      const rows = (data ?? []) as unknown as (Pick<Member, 'user_id' | 'role' | 'job_role' | 'contract_party'> & {
        profiles: Pick<Member, 'display_name' | 'company_name'> | null;
      })[];
      const list = rows.map((r) => ({
        user_id: r.user_id,
        role: r.role,
        display_name: r.profiles?.display_name ?? null,
        company_name: r.profiles?.company_name ?? null,
        job_role: r.job_role ?? null,
        contract_party: r.contract_party ?? null,
      }));

      // Only owners may list invites; the RPC rejects everyone else.
      let pending: PendingInvite[] = [];
      if (list.find((m) => m.user_id === userId)?.role === 'owner') {
        const res = await supabase.rpc('project_pending_invites', { pid: projectId });
        pending = res.error ? (prev?.pending ?? []) : ((res.data ?? []) as PendingInvite[]);
      }
      return { members: list, pending, failed: false };
    },
    { staleTime: 2 * MINUTE },
  );

  const members = data?.members ?? EMPTY_MEMBERS;
  const pending = data?.pending ?? EMPTY_PENDING;
  const failed = data?.failed ?? false;
  const myRole = members.find((m) => m.user_id === userId)?.role ?? null;
  const isOwner = myRole === 'owner';

  /** Each action resolves to true on success. */
  const act = useCallback(
    async (run: () => PromiseLike<{ error: unknown }>) => {
      const { error } = await run();
      await reload();
      // Roles and contract profiles also feed useMyRole and useContract.
      if (!error) invalidateQueries(`project:${projectId}:role`, `project:${projectId}:contract`);
      return !error;
    },
    [projectId, reload],
  );

  const setRole = (uid: string, role: string) =>
    act(() => supabase.rpc('set_member_role', { pid: projectId, uid, new_role: role }));
  const setJobRole = (uid: string, jobRole: JobRole | null) =>
    act(() => supabase.rpc('set_member_job_role', { pid: projectId, uid, new_job_role: jobRole }));
  const setContractParty = (uid: string, contractParty: Party | null) =>
    act(() => supabase.rpc('set_member_contract_party', { pid: projectId, uid, new_contract_party: contractParty }));
  const remove = (uid: string) => act(() => supabase.rpc('remove_member', { pid: projectId, uid }));
  const revoke = (inviteId: string) => act(() => supabase.rpc('revoke_invite', { invite_id: inviteId }));

  return { members, pending, loading, failed, isOwner, myRole, reload, setRole, setJobRole, setContractParty, remove, revoke };
}

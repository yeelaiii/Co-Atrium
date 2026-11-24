import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { PROJECTS_KEY } from '@/hooks/use-projects';
import { invalidateQueries, MINUTE, useCachedQuery } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type MyInvite = {
  invite_id: string;
  project_id: string;
  project_name: string;
  role: string;
  invited_by_name: string | null;
  expires_at: string;
};

type InvitesState = {
  invites: MyInvite[];
  /** Always refetches (pull-to-refresh). */
  reload: () => Promise<void>;
  /** Refetches only if the cached list is stale (screen focus, app foreground). */
  revalidate: () => Promise<void>;
  /** Resolves to an error message, or null on success. */
  respond: (inviteId: string, accept: boolean) => Promise<string | null>;
};

const noop = async () => {};
const InvitesContext = createContext<InvitesState>({ invites: [], reload: noop, revalidate: noop, respond: async () => null });
const EMPTY: MyInvite[] = [];

// Invitations addressed to the signed-in user. Shared so the tab-bar badge and the Projects
// screen agree. Cached: refetched on focus / foreground only once stale, or on pull-to-refresh.
export function InvitesProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id;

  const { data, reload, revalidate } = useCachedQuery<MyInvite[]>(
    userId ? `my-invites:${userId}` : null,
    async (prev) => {
      const { data, error } = await supabase.rpc('my_pending_invites');
      return error ? (prev ?? EMPTY) : ((data ?? []) as MyInvite[]);
    },
    { staleTime: 5 * MINUTE },
  );

  useEffect(() => {
    if (!userId) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void revalidate();
    });
    return () => sub.remove();
  }, [userId, revalidate]);

  const respond = useCallback(
    async (inviteId: string, accept: boolean) => {
      const { error } = await supabase.rpc(accept ? 'accept_invite' : 'decline_invite', { invite_id: inviteId });
      // Accepting adds a project to the Projects list.
      if (!error && accept) invalidateQueries(PROJECTS_KEY);
      await reload();
      return error ? 'That invite is no longer available.' : null;
    },
    [reload],
  );

  // Signed out: never show the previous user's invitations.
  const invites = (userId && data) || EMPTY;
  const value = useMemo(() => ({ invites, reload, revalidate, respond }), [invites, reload, revalidate, respond]);
  return <InvitesContext.Provider value={value}>{children}</InvitesContext.Provider>;
}

export const useMyInvites = () => useContext(InvitesContext);

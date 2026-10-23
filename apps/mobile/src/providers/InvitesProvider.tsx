import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

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
  reload: () => Promise<void>;
  /** Resolves to an error message, or null on success. */
  respond: (inviteId: string, accept: boolean) => Promise<string | null>;
};

const InvitesContext = createContext<InvitesState>({ invites: [], reload: async () => {}, respond: async () => null });

// Invitations addressed to the signed-in user. Shared so the tab-bar badge and the Projects
// screen agree; refetched on focus and whenever the app returns to the foreground.
export function InvitesProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [invites, setInvites] = useState<MyInvite[]>([]);

  const reload = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase.rpc('my_pending_invites');
    if (!error) setInvites((data ?? []) as MyInvite[]);
  }, [userId]);

  // Refetch on mount and whenever the tabs regain focus (e.g. back from a project screen).
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  useEffect(() => {
    if (!userId) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reload();
    });
    return () => sub.remove();
  }, [userId, reload]);

  const respond = useCallback(
    async (inviteId: string, accept: boolean) => {
      const { error } = await supabase.rpc(accept ? 'accept_invite' : 'decline_invite', { invite_id: inviteId });
      await reload();
      return error ? 'That invite is no longer available.' : null;
    },
    [reload],
  );

  // Signed out: never show the previous user's invitations.
  const value = useMemo(() => ({ invites: userId ? invites : [], reload, respond }), [userId, invites, reload, respond]);
  return <InvitesContext.Provider value={value}>{children}</InvitesContext.Provider>;
}

export const useMyInvites = () => useContext(InvitesContext);

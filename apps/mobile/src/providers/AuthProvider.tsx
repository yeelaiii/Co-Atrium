import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { clearQueryCache } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';

type AuthState = { session: Session | null; loading: boolean };

// The user whose data the query cache holds; undefined until the first session is known.
let cachedFor: string | null | undefined;

/** Clears the query cache when the signed-in user changes (sign-out, account switch). */
function trackUser(userId: string | null) {
  // The first session (from getSession or INITIAL_SESSION) is the one the cache is being filled
  // for: clearing then would discard and duplicate every request screens already started.
  if (cachedFor !== undefined && userId !== cachedFor) clearQueryCache();
  cachedFor = userId;
}

const AuthContext = createContext<AuthState>({ session: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      trackUser(data.session?.user.id ?? null);
      setState({ session: data.session, loading: false });
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Never show one user's cached data to another (sign-out, account switch).
      trackUser(session?.user.id ?? null);
      setState({ session, loading: false });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

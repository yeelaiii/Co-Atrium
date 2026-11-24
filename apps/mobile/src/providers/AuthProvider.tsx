import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { clearQueryCache } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';

type AuthState = { session: Session | null; loading: boolean };

// The user whose data the query cache holds.
let cachedFor: string | null = null;

const AuthContext = createContext<AuthState>({ session: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setState({ session: data.session, loading: false }));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Never show one user's cached data to another (sign-out, account switch).
      const userId = session?.user.id ?? null;
      if (userId !== cachedFor) {
        clearQueryCache();
        cachedFor = userId;
      }
      setState({ session, loading: false });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

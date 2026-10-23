import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import {
  promptBiometrics,
  readBiometricPreference,
  writeBiometricPreference,
} from '@/lib/biometrics';
import { supabase } from '@/lib/supabase';

// Re-lock when the app has been in the background at least this long.
const RELOCK_AFTER_MS = 30_000;

type BiometricLockState = {
  /** Preference has been read from storage. */
  loaded: boolean;
  enabled: boolean;
  locked: boolean;
  /** Confirms with a biometric prompt, then turns the lock on. Returns false if declined. */
  enable: () => Promise<boolean>;
  disable: () => Promise<void>;
  /** Prompts to unlock. Returns false if declined. */
  unlock: () => Promise<boolean>;
};

const BiometricLockContext = createContext<BiometricLockState>({
  loaded: false,
  enabled: false,
  locked: false,
  enable: async () => false,
  disable: async () => {},
  unlock: async () => false,
});

export function BiometricLockProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  // Cold start: lock straight away if the user opted in.
  useEffect(() => {
    readBiometricPreference().then((value) => {
      setEnabled(value);
      setLocked(value);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active') {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (enabled && since !== null && Date.now() - since >= RELOCK_AFTER_MS) setLocked(true);
      }
    });
    return () => sub.remove();
  }, [enabled]);

  const disable = useCallback(async () => {
    await writeBiometricPreference(false);
    setEnabled(false);
    setLocked(false);
  }, []);

  // The preference belongs to a signed-in user: clear it on sign out.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') disable();
    });
    return () => data.subscription.unsubscribe();
  }, [disable]);

  const enable = useCallback(async () => {
    if (!(await promptBiometrics('Confirm to turn on biometric unlock'))) return false;
    await writeBiometricPreference(true);
    setEnabled(true);
    return true;
  }, []);

  const unlock = useCallback(async () => {
    if (!(await promptBiometrics('Unlock Co-Atrium'))) return false;
    setLocked(false);
    return true;
  }, []);

  return (
    <BiometricLockContext.Provider value={{ loaded, enabled, locked, enable, disable, unlock }}>
      {children}
    </BiometricLockContext.Provider>
  );
}

export const useBiometricLock = () => useContext(BiometricLockContext);

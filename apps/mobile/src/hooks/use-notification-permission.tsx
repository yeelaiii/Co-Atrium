import {
  AndroidImportance,
  getPermissionsAsync,
  IosAuthorizationStatus,
  requestPermissionsAsync,
  setNotificationChannelAsync,
  type NotificationPermissionsStatus,
} from 'expo-notifications';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';

type PermissionState = {
  /** False until the first permission check resolves. */
  checked: boolean;
  granted: boolean;
  /** False once the OS will no longer show the prompt: the user has to use system settings. */
  canAskAgain: boolean;
  request: () => Promise<void>;
};

const NotificationPermissionContext = createContext<PermissionState>({
  checked: false,
  granted: false,
  canAskAgain: true,
  request: async () => {},
});

const isGranted = (p: NotificationPermissionsStatus) =>
  p.granted || p.ios?.status === IosAuthorizationStatus.PROVISIONAL;

export function NotificationPermissionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ checked: false, granted: false, canAskAgain: true });

  const apply = (p: NotificationPermissionsStatus) =>
    setState({ checked: true, granted: isGranted(p), canAskAgain: p.canAskAgain });

  const refresh = useCallback(() => getPermissionsAsync().then(apply), []);

  // Re-check on foreground so toggling the permission in system settings takes effect straight away.
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  const request = useCallback(async () => {
    // Android 13+ only shows the prompt once a notification channel exists.
    if (Platform.OS === 'android') {
      await setNotificationChannelAsync('default', {
        name: 'Default',
        importance: AndroidImportance.MAX,
      });
    }
    apply(await requestPermissionsAsync());
  }, []);

  const value = useMemo(() => ({ ...state, request }), [state, request]);
  return <NotificationPermissionContext.Provider value={value}>{children}</NotificationPermissionContext.Provider>;
}

export const useNotificationPermission = () => useContext(NotificationPermissionContext);

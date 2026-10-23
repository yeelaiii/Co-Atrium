import '../../global.css';

import { Manrope_400Regular, Manrope_600SemiBold, Manrope_700Bold, useFonts } from '@expo-google-fonts/manrope';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';

import { LockScreen } from '@/components/LockScreen';
import { NotificationPermissionProvider, useNotificationPermission } from '@/hooks/use-notification-permission';
import { isOnboarded } from '@/lib/onboarding';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';
import { BiometricLockProvider, useBiometricLock } from '@/providers/BiometricLockProvider';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, loading } = useAuth();
  const notifications = useNotificationPermission();
  const lock = useBiometricLock();
  const [fontsLoaded] = useFonts({ Manrope_400Regular, Manrope_600SemiBold, Manrope_700Bold });
  const ready = fontsLoaded && !loading && lock.loaded && notifications.checked;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  const signedIn = !!session;
  const onboarded = isOnboarded(session?.user);

  return (
    <View className="flex-1">
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !onboarded}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && onboarded && !notifications.granted}>
        <Stack.Screen name="notifications-required" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && onboarded && notifications.granted}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
    {signedIn && lock.locked && <LockScreen />}
    </View>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <BiometricLockProvider>
        <NotificationPermissionProvider>
          <StatusBar style="auto" />
          <RootNavigator />
        </NotificationPermissionProvider>
      </BiometricLockProvider>
    </AuthProvider>
  );
}

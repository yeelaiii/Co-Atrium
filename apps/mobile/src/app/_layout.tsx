import '../../global.css';

import { Manrope_400Regular, Manrope_600SemiBold, Manrope_700Bold, useFonts } from '@expo-google-fonts/manrope';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { NotificationPermissionProvider, useNotificationPermission } from '@/hooks/use-notification-permission';
import { isOnboarded } from '@/lib/onboarding';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, loading } = useAuth();
  const notifications = useNotificationPermission();
  const [fontsLoaded] = useFonts({ Manrope_400Regular, Manrope_600SemiBold, Manrope_700Bold });
  const ready = fontsLoaded && !loading && notifications.checked;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  const signedIn = !!session;
  const onboarded = isOnboarded(session?.user);

  return (
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
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <NotificationPermissionProvider>
        <StatusBar style="auto" />
        <RootNavigator />
      </NotificationPermissionProvider>
    </AuthProvider>
  );
}

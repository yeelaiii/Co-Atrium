import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/Logo';
import { signOut } from '@/lib/google-auth';
import { useBiometricLock } from '@/providers/BiometricLockProvider';

// Full-screen cover shown over the app while biometric unlock is pending.
export function LockScreen() {
  const insets = useSafeAreaInsets();
  const { unlock } = useBiometricLock();

  useEffect(() => {
    unlock();
  }, [unlock]);

  return (
    <View
      accessibilityViewIsModal
      className="absolute inset-0 bg-background px-6 dark:bg-background-dark"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
      <View className="flex-1 items-center justify-center gap-4">
        <LogoMark width={64} />
        <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Co-Atrium is locked</Text>
      </View>
      <View className="gap-3">
        <Pressable
          accessibilityRole="button"
          onPress={unlock}
          className="min-h-[52px] items-center justify-center rounded-button bg-accent active:opacity-85 dark:bg-accent-dark">
          <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">Unlock</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={signOut} className="min-h-11 items-center justify-center">
          <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

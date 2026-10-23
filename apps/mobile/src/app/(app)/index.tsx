import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/Logo';
import { biometricsAvailable } from '@/lib/biometrics';
import { signOut } from '@/lib/google-auth';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';
import { useBiometricLock } from '@/providers/BiometricLockProvider';
import { useTheme } from '@/theme/use-theme';

// Placeholder home screen: real content (projects, recent records, search) comes later.
export default function Home() {
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const theme = useTheme();
  const lock = useBiometricLock();
  const [canUseBiometrics, setCanUseBiometrics] = useState(false);
  const [profile, setProfile] = useState<{ company_name: string | null; job_role: string | null } | null>(null);

  useEffect(() => {
    if (!session) return;
    supabase
      .from('profiles')
      .select('company_name, job_role')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => setProfile(data));
  }, [session]);

  useEffect(() => {
    biometricsAvailable().then(setCanUseBiometrics);
  }, []);

  const toggleBiometrics = async (value: boolean) => {
    if (value) await lock.enable();
    else await lock.disable();
  };

  return (
    <View
      className="flex-1 bg-background px-6 dark:bg-background-dark"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
      <LogoMark width={44} />
      <View className="flex-1 justify-center">
        <View className="items-center gap-1.5 rounded-card border border-border bg-surface p-6 dark:border-border-dark dark:bg-surface-dark">
          <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Home</Text>
          <Text className="text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {[profile?.job_role, profile?.company_name].filter(Boolean).join(' · ') || session?.user.email}
          </Text>
          <Text className="mt-2 text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            Your projects will appear here.
          </Text>
        </View>
      </View>
      {canUseBiometrics && (
        <View className="mb-3 min-h-12 flex-row items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-2 dark:border-border-dark dark:bg-surface-dark">
          <View className="flex-1">
            <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">
              Unlock with biometrics
            </Text>
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              Ask for Face ID or fingerprint when opening the app.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Unlock with biometrics"
            value={lock.enabled}
            onValueChange={toggleBiometrics}
            trackColor={{ true: theme.accent }}
          />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={signOut}
        className="min-h-12 items-center justify-center rounded-button border border-border dark:border-border-dark">
        <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Sign out</Text>
      </Pressable>
    </View>
  );
}

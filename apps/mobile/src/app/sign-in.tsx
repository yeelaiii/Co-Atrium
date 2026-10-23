import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Logo } from '@/components/Logo';
import { signInWithGoogle } from '@/lib/google-auth';
import { useTheme } from '@/theme/use-theme';

export default function SignIn() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPress = async () => {
    setBusy(true);
    setError(null);
    setError(await signInWithGoogle());
    setBusy(false);
  };

  return (
    <View
      className="flex-1 justify-between bg-background px-6 dark:bg-background-dark"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
      <View className="flex-1 items-center justify-center gap-5">
        <Logo width={260} />
        <Text className="text-center font-manrope text-base text-text-secondary dark:text-text-secondary-dark">
          Capture it on site. Find it again in seconds.
        </Text>
      </View>

      <View className="gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
          disabled={busy}
          onPress={onPress}
          className="min-h-[52px] items-center justify-center rounded-button bg-accent active:opacity-85 disabled:opacity-85 dark:bg-accent-dark">
          {busy ? (
            <ActivityIndicator color={theme.textOnAccent} />
          ) : (
            <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">
              Continue with Google
            </Text>
          )}
        </Pressable>
        {error && (
          <Text
            accessibilityRole="alert"
            className="rounded-card border border-border bg-surface p-3 font-manrope text-sm text-text-primary dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark">
            {error}
          </Text>
        )}
      </View>
    </View>
  );
}

import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/Logo';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

// Landing screen after login. Sanity check only: confirms a Supabase session exists.
export default function Home() {
  const insets = useSafeAreaInsets();
  const { session } = useAuth();

  const signOut = async () => {
    await supabase.auth.signOut();
    await GoogleSignin.signOut().catch(() => {});
  };

  return (
    <View
      className="flex-1 bg-background px-6 dark:bg-background-dark"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
      <LogoMark width={44} />
      <View className="flex-1 justify-center">
        <View className="items-center gap-1.5 rounded-card border border-border bg-surface p-6 dark:border-border-dark dark:bg-surface-dark">
          <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">
            {session ? 'Logged in' : 'Not logged in'}
          </Text>
          {session && (
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              {session.user.email}
            </Text>
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={signOut}
        className="min-h-12 items-center justify-center rounded-button border border-border dark:border-border-dark">
        <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Sign out</Text>
      </Pressable>
    </View>
  );
}

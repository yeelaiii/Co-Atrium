import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/Logo';
import { useProfile } from '@/hooks/use-profile';
import { useAuth } from '@/providers/AuthProvider';

// Placeholder home screen: real content (projects, recent records, search) comes later.
export default function Home() {
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { profile } = useProfile();

  return (
    <View className="flex-1 bg-background px-6 dark:bg-background-dark" style={{ paddingTop: insets.top + 24 }}>
      <LogoMark width={44} />
      <View className="flex-1 justify-center pb-6">
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
    </View>
  );
}

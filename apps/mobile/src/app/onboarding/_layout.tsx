import { Stack, useSegments } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/Logo';
import { ProgressBar } from '@/components/ProgressBar';
import { ONBOARDING_STEPS } from '@/lib/onboarding';
import { OnboardingProvider } from '@/providers/OnboardingProvider';

export default function OnboardingLayout() {
  const insets = useSafeAreaInsets();
  const segments: string[] = useSegments();
  const step = Math.max(ONBOARDING_STEPS.indexOf(segments[segments.length - 1] as never), 0) + 1;

  return (
    <OnboardingProvider>
      <View className="flex-1 bg-background dark:bg-background-dark">
        <View className="gap-5 px-6" style={{ paddingTop: insets.top + 16 }}>
          <ProgressBar step={step} total={ONBOARDING_STEPS.length} />
          <LogoMark width={44} />
        </View>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />
      </View>
    </OnboardingProvider>
  );
}

import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { StepScreen } from '@/components/StepScreen';
import { LANGUAGES } from '@/lib/onboarding';
import { useOnboarding } from '@/providers/OnboardingProvider';

export default function LanguageStep() {
  const router = useRouter();
  const { answers, update } = useOnboarding();

  return (
    <StepScreen
      title="Choose your language"
      subtitle="You can change this later in settings."
      buttonLabel="Continue"
      onPress={() => router.push('/onboarding/privacy')}>
      <View className="gap-2">
        {LANGUAGES.map(({ code, label }) => {
          const active = code === answers.language;
          return (
            <Pressable
              key={code}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              onPress={() => update({ language: code })}
              className={`min-h-14 flex-row items-center gap-3 rounded-card border bg-surface px-4 active:opacity-70 dark:bg-surface-dark ${active ? 'border-accent dark:border-accent-dark' : 'border-border dark:border-border-dark'}`}>
              <Text
                className={`flex-1 text-base text-text-primary dark:text-text-primary-dark ${active ? 'font-manrope-bold' : 'font-manrope'}`}>
                {label}
              </Text>
              {active && (
                <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">Selected</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </StepScreen>
  );
}

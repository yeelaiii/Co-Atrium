import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { StepScreen } from '@/components/StepScreen';
import { useOnboarding } from '@/providers/OnboardingProvider';

export default function PrivacyStep() {
  const router = useRouter();
  const { answers, update } = useOnboarding();
  const accepted = answers.privacyAccepted;

  return (
    <StepScreen
      title="Your privacy"
      subtitle="Please review how Co-Atrium handles your data before you continue."
      buttonLabel="Agree and continue"
      disabled={!accepted}
      onPress={() => router.push('/onboarding/name')}>
      <View className="gap-4">
        <View className="gap-2 rounded-card border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
          {/* TODO: replace with the final privacy policy text or a link to it. */}
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            Placeholder: the full Co-Atrium privacy policy goes here. It will explain what we collect (account details,
            site photos, RFIs and project records), how it is stored, who can see it, and how to request deletion.
          </Text>
        </View>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: accepted }}
          onPress={() => update({ privacyAccepted: !accepted })}
          className="min-h-11 flex-row items-center gap-3">
          <View
            className={`h-6 w-6 items-center justify-center rounded-md border-2 ${accepted ? 'border-accent bg-accent dark:border-accent-dark dark:bg-accent-dark' : 'border-border dark:border-border-dark'}`}>
            {accepted && (
              <Text className="font-manrope-bold text-sm text-text-on-accent dark:text-text-on-accent-dark">✓</Text>
            )}
          </View>
          <Text className="flex-1 font-manrope text-base text-text-primary dark:text-text-primary-dark">
            I have read and agree to the Privacy Policy
          </Text>
        </Pressable>
      </View>
    </StepScreen>
  );
}

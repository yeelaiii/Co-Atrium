import { useRouter } from 'expo-router';
import { Text, TextInput } from 'react-native';

import { StepScreen } from '@/components/StepScreen';
import { useOnboarding } from '@/providers/OnboardingProvider';

export default function NameStep() {
  const router = useRouter();
  const { answers, update } = useOnboarding();
  const name = answers.displayName.trim();

  return (
    <StepScreen
      title="What should we call you?"
      subtitle="This is how teammates will see you."
      buttonLabel="Continue"
      disabled={!name}
      onPress={() => router.push('/onboarding/company')}>
      <Text className="mb-2 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
        Display name
      </Text>
      <TextInput
        accessibilityLabel="Display name"
        value={answers.displayName}
        onChangeText={(displayName) => update({ displayName })}
        placeholder="e.g. Jane Tan"
        placeholderTextColor="#7B8A8E"
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        maxLength={80}
        returnKeyType="next"
        onSubmitEditing={() => name && router.push('/onboarding/company')}
        className="min-h-[52px] rounded-button border border-border bg-surface px-4 font-manrope text-base text-text-primary focus:border-accent dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark dark:focus:border-accent-dark"
      />
    </StepScreen>
  );
}

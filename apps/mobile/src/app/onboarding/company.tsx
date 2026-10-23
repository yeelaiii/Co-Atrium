import { useRouter } from 'expo-router';
import { Text, TextInput } from 'react-native';

import { StepScreen } from '@/components/StepScreen';
import { useOnboarding } from '@/providers/OnboardingProvider';

export default function CompanyStep() {
  const router = useRouter();
  const { answers, update } = useOnboarding();
  const name = answers.companyName.trim();

  return (
    <StepScreen
      title="Where do you work?"
      subtitle="Enter your company name."
      buttonLabel="Continue"
      disabled={!name}
      onPress={() => router.push('/onboarding/role')}>
      <Text className="mb-2 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
        Company name
      </Text>
      <TextInput
        accessibilityLabel="Company name"
        value={answers.companyName}
        onChangeText={(companyName) => update({ companyName })}
        placeholder="e.g. Atrium Architects"
        placeholderTextColor="#7B8A8E"
        autoCapitalize="words"
        autoComplete="organization"
        textContentType="organizationName"
        maxLength={80}
        returnKeyType="next"
        onSubmitEditing={() => name && router.push('/onboarding/role')}
        className="min-h-[52px] rounded-button border border-border bg-surface px-4 font-manrope text-base text-text-primary focus:border-accent dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark dark:focus:border-accent-dark"
      />
    </StepScreen>
  );
}

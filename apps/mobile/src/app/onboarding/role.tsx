import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';

import { OptionSheet } from '@/components/OptionSheet';
import { StepScreen } from '@/components/StepScreen';
import { ROLES, type Role } from '@/lib/onboarding';
import { useOnboarding } from '@/providers/OnboardingProvider';

export default function RoleStep() {
  const router = useRouter();
  const { answers, update } = useOnboarding();
  const [open, setOpen] = useState(false);

  return (
    <StepScreen
      title="What's your role?"
      subtitle="This helps us show you what matters on site."
      buttonLabel="Continue"
      disabled={!answers.role}
      onPress={() => router.push('/onboarding/notifications')}>
      <Text className="mb-2 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Role</Text>
      <Pressable
        accessibilityRole="combobox"
        accessibilityLabel="Role"
        accessibilityValue={{ text: answers.role ?? 'Not selected' }}
        onPress={() => setOpen(true)}
        className="min-h-[52px] flex-row items-center justify-between rounded-button border border-border bg-surface px-4 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
        <Text
          className={`font-manrope text-base ${answers.role ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
          {answers.role ?? 'Select your role'}
        </Text>
        <Text className="font-manrope-bold text-base text-text-secondary dark:text-text-secondary-dark">⌄</Text>
      </Pressable>
      <OptionSheet
        visible={open}
        title="Select your role"
        options={ROLES}
        selected={answers.role}
        onSelect={(role) => {
          update({ role: role as Role });
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </StepScreen>
  );
}

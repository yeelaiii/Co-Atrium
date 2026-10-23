import { Linking, Text, View } from 'react-native';

import { StepScreen } from '@/components/StepScreen';
import { useNotificationPermission } from '@/hooks/use-notification-permission';

type Props = {
  /** Shown only on the onboarding step; the blocking screen has nothing further to continue to. */
  onContinue?: () => void;
  busy?: boolean;
  error?: string | null;
};

// Notifications are required to use Co-Atrium. Used as the last onboarding step and, if permission is
// later revoked, as the blocking screen.
export function NotificationPrompt({ onContinue, busy, error }: Props) {
  const { granted, canAskAgain, request } = useNotificationPermission();

  const label = granted ? 'Continue' : canAskAgain ? 'Enable notifications' : 'Open settings';
  const onPress = granted ? onContinue : canAskAgain ? request : Linking.openSettings;

  return (
    <StepScreen
      title="Turn on notifications"
      subtitle="RFIs, instructions and changes need a response from you. Co-Atrium needs notifications switched on to keep your team moving."
      buttonLabel={label}
      onPress={() => onPress?.()}
      busy={busy}
      error={error}>
      {!granted && !canAskAgain && (
        <View className="rounded-card border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
          <Text accessibilityRole="alert" className="font-manrope text-sm text-text-primary dark:text-text-primary-dark">
            Notifications are turned off for Co-Atrium. Open settings, allow notifications, then come back to continue.
          </Text>
        </View>
      )}
      {granted && (
        <View className="rounded-card border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
          <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
            Notifications are on.
          </Text>
        </View>
      )}
    </StepScreen>
  );
}

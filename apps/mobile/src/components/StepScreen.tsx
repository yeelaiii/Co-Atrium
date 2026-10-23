import type { ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme/use-theme';

type Props = {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  buttonLabel: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
  /** Optional quiet action under the primary button. */
  secondaryLabel?: string;
  onSecondaryPress?: () => void;
};

// Shared frame for onboarding steps: title, content, one primary button pinned to the bottom.
export function StepScreen({
  title,
  subtitle,
  children,
  buttonLabel,
  onPress,
  disabled,
  busy,
  error,
  secondaryLabel,
  onSecondaryPress,
}: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const inactive = disabled || busy;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background dark:bg-background-dark">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-2 px-6 pt-6"
        keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" className="font-manrope-bold text-3xl text-text-primary dark:text-text-primary-dark">
          {title}
        </Text>
        {subtitle && (
          <Text className="font-manrope text-base text-text-secondary dark:text-text-secondary-dark">{subtitle}</Text>
        )}
        <View className="mt-4">{children}</View>
      </ScrollView>

      <View className="gap-3 px-6 pt-3" style={{ paddingBottom: insets.bottom + 16 }}>
        {error && (
          <Text
            accessibilityRole="alert"
            className="rounded-card border border-border bg-surface p-3 font-manrope text-sm text-text-primary dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark">
            {error}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !!inactive, busy: !!busy }}
          disabled={inactive}
          onPress={onPress}
          className={`min-h-[52px] items-center justify-center rounded-button bg-accent active:opacity-85 dark:bg-accent-dark ${disabled && !busy ? 'opacity-40' : ''}`}>
          {busy ? (
            <ActivityIndicator color={theme.textOnAccent} />
          ) : (
            <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">
              {buttonLabel}
            </Text>
          )}
        </Pressable>
        {secondaryLabel && (
          <Pressable
            accessibilityRole="button"
            onPress={onSecondaryPress}
            className="min-h-11 items-center justify-center">
            <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">{secondaryLabel}</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

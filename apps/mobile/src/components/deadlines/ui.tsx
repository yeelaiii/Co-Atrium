// Small building blocks shared by the contract and deadline screens.

import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View, useColorScheme } from 'react-native';

import { VoIcon, type VoIconName } from '@/components/vo/icons';
import { DISCLAIMER, type ObligationStatus } from '@/lib/deadlines';
import { useTheme } from '@/theme/use-theme';

export const inputClass =
  'min-h-[52px] rounded-button border border-border bg-surface px-4 font-manrope text-base text-text-primary focus:border-accent dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark dark:focus:border-accent-dark';

export const cardClass = 'rounded-card border border-border bg-surface dark:border-border-dark dark:bg-surface-dark';

export function BackLink({ label = '‹ Back' }: { label?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label.replace('‹ ', '')}
      onPress={() => router.back()}
      hitSlop={8}
      className="min-h-11 justify-center self-start active:opacity-70">
      <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">{label}</Text>
    </Pressable>
  );
}

export function Title({ children, subtitle }: { children: ReactNode; subtitle?: string }) {
  return (
    <View className="mb-4 gap-1">
      <Text accessibilityRole="header" className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">
        {children}
      </Text>
      {subtitle && <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{subtitle}</Text>}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" className="mb-2 mt-5 font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
      {children}
    </Text>
  );
}

export function Label({ text, optional = false, className = '' }: { text: string; optional?: boolean; className?: string }) {
  return (
    <Text className={`mb-2 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark ${className}`}>
      {text}
      {optional && <Text className="font-manrope text-text-secondary dark:text-text-secondary-dark"> (optional)</Text>}
    </Text>
  );
}

export function PrimaryButton({ label, onPress, disabled, busy }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      className={`min-h-12 flex-row items-center justify-center gap-2 rounded-button bg-accent px-4 dark:bg-accent-dark ${disabled ? 'opacity-40' : 'active:opacity-80'}`}>
      {busy && <ActivityIndicator color={theme.textOnAccent} />}
      <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled, icon }: { label: string; onPress: () => void; disabled?: boolean; icon?: VoIconName }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-12 flex-row items-center justify-center gap-2 rounded-button border border-border px-4 dark:border-border-dark ${disabled ? 'opacity-40' : 'active:opacity-70'}`}>
      {icon && <VoIcon name={icon} color={theme.textPrimary} size={18} />}
      <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{label}</Text>
    </Pressable>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" className="mt-3 font-manrope text-sm text-red-700 dark:text-red-400">
      Error: {message}
    </Text>
  );
}

/** "Aid only, not legal advice": shown on every contract and deadline screen. */
export function Disclaimer() {
  return <Text className="mt-6 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{DISCLAIMER}</Text>;
}

// Never colour alone: every status has an icon and a text label.
const STATUS: Record<ObligationStatus | 'time_bar', { icon: VoIconName; label: string; light: string; dark: string; cls: string }> = {
  overdue: { icon: 'alert', label: 'Overdue', light: '#B91C1C', dark: '#F87171', cls: 'border-red-700 text-red-700 dark:border-red-400 dark:text-red-400' },
  open: { icon: 'clock', label: 'Open', light: '#B45309', dark: '#FCD34D', cls: 'border-amber-700 text-amber-700 dark:border-amber-300 dark:text-amber-300' },
  suggested: { icon: 'plus', label: 'Suggested', light: '#1D4ED8', dark: '#93C5FD', cls: 'border-blue-700 text-blue-700 dark:border-blue-300 dark:text-blue-300' },
  met: { icon: 'check', label: 'Met', light: '#15803D', dark: '#4ADE80', cls: 'border-green-700 text-green-700 dark:border-green-400 dark:text-green-400' },
  waived: { icon: 'close', label: 'Waived', light: '#4A5B60', dark: '#A9B8BB', cls: 'border-border text-text-secondary dark:border-border-dark dark:text-text-secondary-dark' },
  time_bar: { icon: 'flag', label: 'Time bar', light: '#B91C1C', dark: '#F87171', cls: 'border-red-700 text-red-700 dark:border-red-400 dark:text-red-400' },
};

export function StatusPill({ status, label }: { status: keyof typeof STATUS; label?: string }) {
  const dark = useColorScheme() === 'dark';
  const s = STATUS[status];
  return (
    <View className={`flex-row items-center gap-1 self-start rounded-full border px-2.5 py-1 ${s.cls.split(' ').filter((c) => c.includes('border')).join(' ')}`}>
      <VoIcon name={s.icon} color={dark ? s.dark : s.light} size={14} strokeWidth={2.2} />
      <Text className={`font-manrope-semibold text-xs ${s.cls.split(' ').filter((c) => c.includes('text')).join(' ')}`}>{label ?? s.label}</Text>
    </View>
  );
}

/** A tappable row inside a card list. */
export function RowLink({ title, detail, onPress, right, last }: { title: string; detail?: string | null; onPress: () => void; right?: ReactNode; last?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 ${last ? '' : 'border-b border-border dark:border-border-dark'}`}>
      <View className="flex-1 gap-0.5">
        <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{title}</Text>
        {detail ? <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{detail}</Text> : null}
      </View>
      {right}
      <Text className="font-manrope text-lg text-text-secondary dark:text-text-secondary-dark">›</Text>
    </Pressable>
  );
}

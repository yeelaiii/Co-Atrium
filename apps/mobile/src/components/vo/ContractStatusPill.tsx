import { VO_STATUS_LABEL, type VoContractStatus } from '@shared/contracts/variations.ts';
import { Text, View, useColorScheme } from 'react-native';

import { VoIcon, type VoIconName } from './icons';

type Tone = 'amber' | 'blue' | 'green' | 'red' | 'neutral';

const TONE: Record<Tone, { light: string; dark: string; border: string; text: string }> = {
  amber: { light: '#B45309', dark: '#FCD34D', border: 'border-amber-700 dark:border-amber-300', text: 'text-amber-700 dark:text-amber-300' },
  blue: { light: '#1D4ED8', dark: '#93C5FD', border: 'border-blue-700 dark:border-blue-300', text: 'text-blue-700 dark:text-blue-300' },
  green: { light: '#15803D', dark: '#4ADE80', border: 'border-green-700 dark:border-green-400', text: 'text-green-700 dark:text-green-400' },
  red: { light: '#B91C1C', dark: '#F87171', border: 'border-red-700 dark:border-red-400', text: 'text-red-700 dark:text-red-400' },
  neutral: { light: '#4A5B60', dark: '#A9B8BB', border: 'border-border dark:border-border-dark', text: 'text-text-secondary dark:text-text-secondary-dark' },
};

// Never colour alone: every status has its own icon and label.
const STATUS: Record<VoContractStatus, { icon: VoIconName; tone: Tone }> = {
  unconfirmed: { icon: 'alert', tone: 'amber' },
  identified: { icon: 'flag', tone: 'neutral' },
  instructed: { icon: 'file', tone: 'blue' },
  quotation_submitted: { icon: 'clock', tone: 'amber' },
  valuation_issued: { icon: 'clock', tone: 'amber' },
  agreed: { icon: 'check', tone: 'green' },
  disputed: { icon: 'alert', tone: 'red' },
  rejected: { icon: 'close', tone: 'neutral' },
  withdrawn: { icon: 'close', tone: 'neutral' },
};

export function ContractStatusPill({ status }: { status: VoContractStatus }) {
  const dark = useColorScheme() === 'dark';
  const s = STATUS[status];
  const t = TONE[s.tone];
  return (
    <View className={`flex-row items-center gap-1 self-start rounded-full border px-2.5 py-1 ${t.border}`}>
      <VoIcon name={s.icon} color={dark ? t.dark : t.light} size={14} strokeWidth={2.2} />
      <Text className={`font-manrope-semibold text-xs ${t.text}`}>{VO_STATUS_LABEL[status]}</Text>
    </View>
  );
}

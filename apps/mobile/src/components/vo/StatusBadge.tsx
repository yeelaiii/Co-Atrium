import { Text, View, useColorScheme } from 'react-native';

import { VO_BUCKETS, type VoBucket } from '@/lib/variation-orders';
import { useTheme } from '@/theme/use-theme';

import { VoIcon } from './icons';

// Never colour alone: every status has an icon and a text label.
// "Pending your approval" uses the accent: it is the one item that needs this person.
const STYLE: Record<VoBucket, { icon: 'clock' | 'check'; light?: string; dark?: string; border: string; text: string }> = {
  pending: {
    icon: 'clock',
    light: '#B45309',
    dark: '#FCD34D',
    border: 'border-amber-700 dark:border-amber-300',
    text: 'text-amber-700 dark:text-amber-300',
  },
  yours: {
    icon: 'clock',
    border: 'border-accent dark:border-accent-dark',
    text: 'text-accent dark:text-accent-dark',
  },
  completed: {
    icon: 'check',
    light: '#15803D',
    dark: '#4ADE80',
    border: 'border-green-700 dark:border-green-400',
    text: 'text-green-700 dark:text-green-400',
  },
};

export function useStatusColor(bucket: VoBucket) {
  const theme = useTheme();
  const dark = useColorScheme() === 'dark';
  const s = STYLE[bucket];
  return (dark ? s.dark : s.light) ?? theme.accent;
}

export function StatusBadge({ bucket }: { bucket: VoBucket }) {
  const s = STYLE[bucket];
  const color = useStatusColor(bucket);
  const label = VO_BUCKETS.find((b) => b.bucket === bucket)!.label;

  return (
    <View className={`flex-row items-center gap-1 self-start rounded-full border px-2.5 py-1 ${s.border}`}>
      <VoIcon name={s.icon} color={color} size={14} strokeWidth={2.2} />
      <Text className={`font-manrope-semibold text-xs ${s.text}`}>{label}</Text>
    </View>
  );
}

// Status and confidence badges for contract documents and extracted values. Never colour
// alone: every badge has an icon and a text label.

import { Text, useColorScheme, View } from 'react-native';

import { VoIcon, type VoIconName } from '@/components/vo/icons';
import type { ExtractionStatus } from '@/lib/contract-documents';

type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'error';

const TONE: Record<Tone, { light: string; dark: string; cls: string }> = {
  neutral: { light: '#4A5B60', dark: '#A9B8BB', cls: 'border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark' },
  info: { light: '#1D4ED8', dark: '#93C5FD', cls: 'border-blue-700 dark:border-blue-300 text-blue-700 dark:text-blue-300' },
  warning: { light: '#B45309', dark: '#FCD34D', cls: 'border-amber-700 dark:border-amber-300 text-amber-700 dark:text-amber-300' },
  success: { light: '#15803D', dark: '#4ADE80', cls: 'border-green-700 dark:border-green-400 text-green-700 dark:text-green-400' },
  error: { light: '#B91C1C', dark: '#F87171', cls: 'border-red-700 dark:border-red-400 text-red-700 dark:text-red-400' },
};

export function Badge({ tone, icon, label }: { tone: Tone; icon: VoIconName; label: string }) {
  const dark = useColorScheme() === 'dark';
  const t = TONE[tone];
  const classes = t.cls.split(' ');
  return (
    <View className={`flex-row items-center gap-1 self-start rounded-full border px-2.5 py-1 ${classes.filter((c) => c.includes('border')).join(' ')}`}>
      <VoIcon name={icon} color={dark ? t.dark : t.light} size={14} strokeWidth={2.2} />
      <Text className={`font-manrope-semibold text-xs ${classes.filter((c) => c.includes('text')).join(' ')}`}>{label}</Text>
    </View>
  );
}

const STATUS: Record<ExtractionStatus, { tone: Tone; icon: VoIconName; label: string }> = {
  queued: { tone: 'neutral', icon: 'clock', label: 'Queued' },
  processing: { tone: 'info', icon: 'clock', label: 'Extracting' },
  needs_review: { tone: 'warning', icon: 'alert', label: 'Needs review' },
  complete: { tone: 'success', icon: 'check', label: 'Reviewed' },
  failed: { tone: 'error', icon: 'close', label: 'Failed' },
};

export function DocumentStatusBadge({ status }: { status: ExtractionStatus }) {
  return <Badge {...STATUS[status]} />;
}

/** "High 96%" / "Check 62%" against the project's threshold (default 0.9). */
export function ConfidenceBadge({ confidence, threshold }: { confidence: number; threshold: number }) {
  const pct = Math.round(confidence * 100);
  return confidence >= threshold
    ? <Badge tone="success" icon="check" label={`High confidence ${pct}%`} />
    : <Badge tone="warning" icon="alert" label={`Check: ${pct}% confidence`} />;
}

/** Determinate progress bar (0..1) with an accessible value. */
export function UploadProgress({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      className="h-1.5 overflow-hidden rounded-full bg-border dark:bg-border-dark">
      <View className="h-full rounded-full bg-accent dark:bg-accent-dark" style={{ width: `${pct}%` }} />
    </View>
  );
}

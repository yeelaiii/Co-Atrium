import { formatShortDate } from '@shared/deadlines/calendar.ts';
import { router } from 'expo-router';
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { PARTY_LABEL, type Obligation } from '@/lib/deadlines';

import { StatusPill } from './ui';

function daysLeft(dueAt: string): string {
  const d = Math.ceil((new Date(dueAt).getTime() - Date.now()) / 86_400_000);
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} late`;
  if (d === 0) return 'due today';
  return `${d} day${d === 1 ? '' : 's'} left`;
}

export const ObligationRow = memo(function ObligationRow({ o }: { o: Obligation }) {
  const title = o.subject ? `${o.subject} ${o.reminder_label}` : o.obligation;
  const open = o.status === 'open' || o.status === 'overdue';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${o.status}, due ${formatShortDate(o.due_date, true)}${o.is_time_bar ? ', time bar' : ''}`}
      onPress={() => router.push({ pathname: '/project/[id]/deadlines/[obligationId]', params: { id: o.project_id, obligationId: o.id } })}
      className={`mb-2 gap-2 rounded-card border bg-surface px-4 py-3 active:opacity-70 dark:bg-surface-dark ${
        o.status === 'overdue' ? 'border-accent dark:border-accent-dark' : 'border-border dark:border-border-dark'
      }`}>
      <View className="flex-row items-start justify-between gap-3">
        <Text className="flex-1 font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{title}</Text>
        <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">{formatShortDate(o.due_date)}</Text>
      </View>
      <Text numberOfLines={2} className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
        {PARTY_LABEL[o.responsible_party]} · {o.explanation}
      </Text>
      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill status={o.status} />
        {o.is_time_bar && <StatusPill status="time_bar" />}
        {open && <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{daysLeft(o.due_at)}</Text>}
      </View>
    </Pressable>
  );
});

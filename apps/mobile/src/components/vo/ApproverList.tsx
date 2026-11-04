import { Text, View } from 'react-native';

import { approvalProgress, formatSentAt, type VariationOrder } from '@/lib/variation-orders';
import { useTheme } from '@/theme/use-theme';

import { useStatusColor } from './StatusBadge';
import { VoIcon } from './icons';

/** Who was asked to approve, with a tick or a clock (plus text) for each. */
export function ApproverList({ vo, me }: { vo: VariationOrder; me: string | undefined }) {
  const theme = useTheme();
  const green = useStatusColor('completed');
  const { done, total } = approvalProgress(vo);

  return (
    <View className="gap-2">
      <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">
        {total === 0 ? 'No approvers yet' : `Approvals · ${done} of ${total}`}
      </Text>
      {vo.approvers.map((a, i) => {
        const name = `${a.name ?? 'Former member'}${a.userId === me ? ' (you)' : ''}`;
        return (
          <View
            key={a.userId ?? `gone-${i}`}
            accessible
            accessibilityLabel={`${name}, ${a.approvedAt ? `approved ${formatSentAt(a.approvedAt)}` : 'not approved yet'}`}
            className="flex-row items-center gap-2">
            <VoIcon name={a.approvedAt ? 'check' : 'clock'} color={a.approvedAt ? green : theme.textSecondary} size={18} strokeWidth={2.2} />
            <Text className="flex-1 font-manrope text-sm text-text-primary dark:text-text-primary-dark">{name}</Text>
            <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              {a.approvedAt ? `Approved ${formatSentAt(a.approvedAt)}` : 'Waiting'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Everyone else the VO is shared with who isn't an approver (the sender is shown elsewhere). */
export function IncludedList({ vo, me }: { vo: VariationOrder; me: string | undefined }) {
  const approverIds = new Set(vo.approvers.map((a) => a.userId));
  const others = vo.participants.filter((p) => p.userId !== vo.sentById && !approverIds.has(p.userId));
  return (
    <View className="gap-1">
      <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">
        Also included · {others.length}
      </Text>
      <Text className="font-manrope text-sm text-text-primary dark:text-text-primary-dark">
        {others.length === 0
          ? 'Nobody else. Only the sender and approvers can see this VO.'
          : others.map((p) => `${p.name ?? 'Unnamed'}${p.userId === me ? ' (you)' : ''}`).join(', ')}
      </Text>
    </View>
  );
}

import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, Text, View } from 'react-native';

import { approvalProgress, formatSentAt, VO_BUCKETS, voBucket, voCode, type VariationOrder, type VoBucket } from '@/lib/variation-orders';
import { useTheme } from '@/theme/use-theme';

import { NoPhoto, VoPhoto } from './VoPhoto';

function VoRow({ vo, bucket, onPress }: { vo: VariationOrder; bucket: VoBucket; onPress: () => void }) {
  const { done, total } = approvalProgress(vo);
  const progress = total === 0 ? 'No approvers' : `${done} of ${total} approved`;
  const sender = vo.sentByName ?? 'Former member';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${voCode(vo)}, ${vo.name}. ${vo.location ?? ''}. Sent by ${sender}, ${formatSentAt(vo.sentAt)}. ${progress}. Open`}
      onPress={onPress}
      className="min-h-20 flex-row gap-3 rounded-card border border-border bg-surface p-3 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      {/* Accent marker on the items waiting for this person, echoing the orange bar in the logo. */}
      {bucket === 'yours' && <View className="w-1 rounded-full bg-accent dark:bg-accent-dark" />}
      <View className="overflow-hidden rounded-button">
        {vo.photos[0] ? <VoPhoto path={vo.photos[0]} style={{ width: 64, height: 64 }} /> : <NoPhoto style={{ width: 64, height: 64 }} />}
      </View>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-baseline justify-between gap-2">
          <Text className="font-manrope-bold text-xs text-text-secondary dark:text-text-secondary-dark">{voCode(vo)}</Text>
          <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{formatSentAt(vo.sentAt)}</Text>
        </View>
        <Text numberOfLines={2} className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">
          {vo.name}
        </Text>
        {vo.location && (
          <Text numberOfLines={1} className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {vo.location}
          </Text>
        )}
        <Text numberOfLines={1} className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
          {sender} · {progress}
        </Text>
      </View>
    </Pressable>
  );
}

type Props = {
  variationOrders: VariationOrder[];
  me: string | undefined;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
  onOpen: (vo: VariationOrder) => void;
};

/** Every VO, grouped by status. */
export function VoListView({ variationOrders, me, loading, failed, reload, onOpen }: Props) {
  const theme = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  const sections = useMemo(
    () =>
      VO_BUCKETS.map(({ bucket, label }) => ({
        bucket,
        label,
        data: variationOrders.filter((vo) => voBucket(vo, me) === bucket),
      })),
    [variationOrders, me],
  );

  const refresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  if (loading && variationOrders.length === 0) return <ActivityIndicator color={theme.accent} className="mt-8" />;

  return (
    <SectionList
      sections={sections}
      keyExtractor={(vo) => vo.id}
      refreshing={refreshing}
      onRefresh={refresh}
      stickySectionHeadersEnabled={false}
      contentContainerClassName="px-6 pb-28 pt-2"
      ItemSeparatorComponent={() => <View className="h-3" />}
      ListHeaderComponent={
        failed ? (
          <Text accessibilityRole="alert" className="pt-2 font-manrope text-sm text-red-700 dark:text-red-400">
            Error: Could not load variation orders. Pull down to try again.
          </Text>
        ) : undefined
      }
      renderSectionHeader={({ section }) => (
        <View className="flex-row items-center gap-2 pb-2 pt-5">
          <Text accessibilityRole="header" className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
            {section.label}
          </Text>
          <Text className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">· {section.data.length}</Text>
        </View>
      )}
      renderSectionFooter={({ section }) =>
        section.data.length === 0 ? (
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {section.bucket === 'yours' ? 'Nothing is waiting for your approval.' : 'None.'}
          </Text>
        ) : null
      }
      renderItem={({ item, section }) => <VoRow vo={item} bucket={section.bucket} onPress={() => onOpen(item)} />}
    />
  );
}

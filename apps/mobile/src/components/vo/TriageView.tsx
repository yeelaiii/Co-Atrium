import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { voBucket, voCode, formatSentAt, type VariationOrder } from '@/lib/variation-orders';
import { useTheme } from '@/theme/use-theme';

import { ApproveButton } from './ApproveButton';
import { ApproverList, IncludedList } from './ApproverList';
import { NoPhoto, PhotoViewer, VoPhoto } from './VoPhoto';
import { StatusBadge } from './StatusBadge';
import { VoIcon } from './icons';

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <View className="min-w-[45%] flex-1 gap-0.5">
      <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">{label}</Text>
      <Text selectable className="font-manrope text-base text-text-primary dark:text-text-primary-dark">
        {value ?? '—'}
      </Text>
    </View>
  );
}

export function ThreadButton({ vo }: { vo: VariationOrder }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open thread for ${voCode(vo)}`}
      onPress={() => router.push({ pathname: '/project/[id]/vo/[voId]', params: { id: vo.projectId, voId: vo.id } })}
      hitSlop={6}
      className="min-h-11 flex-row items-center gap-1.5 rounded-button border border-border bg-surface px-3 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      <VoIcon name="thread" color={theme.textPrimary} size={20} />
      <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Thread</Text>
    </Pressable>
  );
}

function TriageCard({ vo, me, width, onChanged, refreshing, onRefresh }: {
  vo: VariationOrder;
  me: string | undefined;
  width: number;
  onChanged: () => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const theme = useTheme();
  const [photoIndex, setPhotoIndex] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);
  const bucket = voBucket(vo, me);
  const main = vo.photos[Math.min(photoIndex, vo.photos.length - 1)];
  const photoWidth = width - 48;
  const photoStyle = { width: photoWidth, height: Math.round(photoWidth * 0.75) };

  return (
    <ScrollView
      style={{ width }}
      contentContainerClassName="gap-4 px-6 pb-8 pt-4"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} colors={[theme.accent]} />}>
      {/* The photo is the focus of triage. */}
      <View className="overflow-hidden rounded-card border border-border dark:border-border-dark">
        {main ? (
          <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Photo of ${vo.name}. Open full screen`} onPress={() => setViewing(main)}>
            <VoPhoto path={main} style={photoStyle} />
          </Pressable>
        ) : (
          <NoPhoto style={photoStyle} />
        )}
        {vo.photos.length > 1 && (
          <View className="absolute bottom-3 right-3 rounded-full bg-black/60 px-2.5 py-1">
            <Text className="font-manrope-semibold text-xs text-white">
              {photoIndex + 1} / {vo.photos.length}
            </Text>
          </View>
        )}
      </View>

      {vo.photos.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2" nestedScrollEnabled>
          {vo.photos.map((path, i) => (
            <Pressable
              key={path}
              accessibilityRole="imagebutton"
              accessibilityLabel={`Show photo ${i + 1} of ${vo.photos.length}`}
              accessibilityState={{ selected: i === photoIndex }}
              onPress={() => setPhotoIndex(i)}
              className={`overflow-hidden rounded-button border-2 ${i === photoIndex ? 'border-accent dark:border-accent-dark' : 'border-transparent'}`}>
              <VoPhoto path={path} style={{ width: 56, height: 56 }} />
            </Pressable>
          ))}
        </ScrollView>
      )}

      <View className="gap-2">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1 flex-row flex-wrap items-center gap-2">
            <Text className="font-manrope-bold text-sm text-text-secondary dark:text-text-secondary-dark">{voCode(vo)}</Text>
            <StatusBadge bucket={bucket} />
          </View>
          <ThreadButton vo={vo} />
        </View>
        <Text accessibilityRole="header" className="font-manrope-bold text-xl text-text-primary dark:text-text-primary-dark">
          {vo.name}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-x-4 gap-y-3 rounded-card border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
        <Field label="Location" value={vo.location} />
        <Field label="Sent by" value={vo.sentByName ?? (vo.sentById ? 'Unknown' : 'Former member')} />
        <Field label="Requested by" value={vo.requestedBy} />
        <Field label="Time sent" value={formatSentAt(vo.sentAt)} />
      </View>

      <View className="gap-1">
        <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">Description</Text>
        <Text
          selectable
          className={
            vo.description
              ? 'font-manrope text-base leading-6 text-text-primary dark:text-text-primary-dark'
              : 'font-manrope text-base text-text-secondary dark:text-text-secondary-dark'
          }>
          {vo.description ?? 'No description.'}
        </Text>
      </View>

      <View className="gap-4 rounded-card border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
        <ApproverList vo={vo} me={me} />
        <IncludedList vo={vo} me={me} />
      </View>

      {bucket === 'yours' && <ApproveButton vo={vo} onApproved={onChanged} />}

      <PhotoViewer path={viewing} onClose={() => setViewing(null)} />
    </ScrollView>
  );
}

type Props = {
  variationOrders: VariationOrder[];
  me: string | undefined;
  /** VO to open on first render (e.g. from a notification). */
  initialVoId?: string;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
};

/** One VO at a time, photo first. Swipe or use the arrows to move between them. */
export function TriageView({ variationOrders, me, initialVoId, loading, failed, reload }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<VariationOrder>>(null);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Follow the VO being looked at, not its position: approving one moves it to another bucket.
  const currentId = useRef<string | undefined>(initialVoId);

  const refresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  useEffect(() => {
    if (!width || variationOrders.length === 0) return;
    const found = variationOrders.findIndex((vo) => vo.id === currentId.current);
    const next = found >= 0 ? found : Math.min(index, variationOrders.length - 1);
    currentId.current = variationOrders[next].id;
    if (next !== index) setIndex(next);
    listRef.current?.scrollToOffset({ offset: next * width, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-anchor when the data or size changes
  }, [variationOrders, width]);

  const goTo = (i: number) => {
    const clamped = Math.max(0, Math.min(variationOrders.length - 1, i));
    currentId.current = variationOrders[clamped]?.id;
    setIndex(clamped);
    listRef.current?.scrollToOffset({ offset: clamped * width, animated: true });
  };

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  if (loading && variationOrders.length === 0) {
    return <ActivityIndicator color={theme.accent} className="mt-8" />;
  }
  if (variationOrders.length === 0) {
    return (
      <ScrollView
        contentContainerClassName="items-center gap-2 px-8 pt-16"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.accent} colors={[theme.accent]} />}>
        <Text className="text-center font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">
          {failed ? 'Could not load variation orders' : 'No variation orders yet'}
        </Text>
        <Text className="text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          {failed ? 'Pull down to try again.' : 'Variation orders sent in this project will appear here, one at a time.'}
        </Text>
      </ScrollView>
    );
  }

  const current = variationOrders[index];

  return (
    <View className="flex-1" onLayout={onLayout}>
      {width > 0 && (
        <FlatList
          ref={listRef}
          data={variationOrders}
          keyExtractor={(vo) => vo.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialNumToRender={2}
          windowSize={3}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onMomentumScrollEnd={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            currentId.current = variationOrders[i]?.id;
            setIndex(i);
          }}
          renderItem={({ item }) => (
            <TriageCard vo={item} me={me} width={width} onChanged={reload} refreshing={refreshing} onRefresh={refresh} />
          )}
        />
      )}

      <View
        style={{ paddingBottom: insets.bottom }}
        className="min-h-14 flex-row items-center justify-between border-t border-border bg-surface px-4 dark:border-border-dark dark:bg-surface-dark">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous variation order"
          accessibilityState={{ disabled: index === 0 }}
          disabled={index === 0}
          onPress={() => goTo(index - 1)}
          className={`h-11 w-11 items-center justify-center ${index === 0 ? 'opacity-30' : 'active:opacity-70'}`}>
          <VoIcon name="chevron-left" color={theme.textPrimary} size={24} />
        </Pressable>
        <Text accessibilityLiveRegion="polite" className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
          {current ? `${voCode(current)} · ${index + 1} of ${variationOrders.length}` : ''}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next variation order"
          accessibilityState={{ disabled: index >= variationOrders.length - 1 }}
          disabled={index >= variationOrders.length - 1}
          onPress={() => goTo(index + 1)}
          className={`h-11 w-11 items-center justify-center ${index >= variationOrders.length - 1 ? 'opacity-30' : 'active:opacity-70'}`}>
          <VoIcon name="chevron-right" color={theme.textPrimary} size={24} />
        </Pressable>
      </View>
    </View>
  );
}

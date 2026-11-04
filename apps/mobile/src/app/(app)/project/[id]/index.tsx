import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DetailsPanel } from '@/components/project/DetailsPanel';
import { MembersPanel } from '@/components/project/MembersPanel';
import { VariationOrdersPanel } from '@/components/vo/VariationOrdersPanel';
import { useMyRole } from '@/hooks/use-my-role';
import { useProject } from '@/hooks/use-project';
import { useVariationOrders } from '@/hooks/use-variation-orders';

const TABS = [
  { key: 'vos', label: 'VOs', a11y: 'Variation orders' },
  { key: 'details', label: 'Details', a11y: 'Details' },
  { key: 'members', label: 'Members', a11y: 'Members' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const isTab = (value: string | undefined): value is TabKey => TABS.some((t) => t.key === value);

export default function ProjectScreen() {
  // `vo` opens the variation orders tab on that VO (used by push notifications).
  const { id, tab: initialTab, vo } = useLocalSearchParams<{ id: string; tab?: string; vo?: string }>();
  const insets = useSafeAreaInsets();
  const { project, loading, failed, reload } = useProject(id);
  const variationOrders = useVariationOrders(id);
  const { canWrite } = useMyRole(id);
  const [tab, setTab] = useState<TabKey>(isTab(initialTab) ? initialTab : 'vos');
  const awaiting = variationOrders.awaitingMe;

  // A notification for a VO arrived while this project was already open: show the VOs tab.
  const [seenVo, setSeenVo] = useState(vo);
  if (vo !== seenVo) {
    setSeenVo(vo);
    if (vo) setTab('vos');
  }

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <View className="gap-2 px-6 pt-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={8}
          className="min-h-11 justify-center self-start active:opacity-70">
          <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">‹ Back</Text>
        </Pressable>

        <Text
          accessibilityRole="header"
          numberOfLines={2}
          className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">
          {project?.name ?? ' '}
        </Text>
      </View>

      <View accessibilityRole="tablist" className="mt-2 flex-row border-b border-border px-6 dark:border-border-dark">
        {TABS.map(({ key, label, a11y }) => {
          const selected = tab === key;
          const badge = key === 'vos' && awaiting > 0 ? awaiting : null;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={badge ? `${a11y}, ${badge} waiting for your approval` : a11y}
              onPress={() => setTab(key)}
              className="min-h-12 flex-1 flex-row items-center justify-center gap-1.5 active:opacity-70">
              <Text
                className={
                  selected
                    ? 'font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark'
                    : 'font-manrope-semibold text-base text-text-secondary dark:text-text-secondary-dark'
                }>
                {label}
              </Text>
              {/* A number, not just a dot, so the signal isn't colour alone. */}
              {badge && (
                <View className="h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 dark:bg-accent-dark">
                  <Text className="font-manrope-bold text-xs text-text-on-accent dark:text-text-on-accent-dark">{badge}</Text>
                </View>
              )}
              {/* Accent marker on the selected tab, echoing the orange bar in the logo. */}
              <View
                className={`absolute bottom-0 h-0.5 w-full rounded-full ${selected ? 'bg-accent dark:bg-accent-dark' : 'bg-transparent'}`}
              />
            </Pressable>
          );
        })}
      </View>

      {tab === 'vos' ? (
        <VariationOrdersPanel projectId={id} data={variationOrders} canCreate={canWrite} focusVoId={vo} />
      ) : tab === 'details' ? (
        <DetailsPanel project={project} loading={loading} failed={failed} reload={reload} />
      ) : (
        <MembersPanel projectId={id} />
      )}
    </View>
  );
}

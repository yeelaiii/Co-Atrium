import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DetailsPanel } from '@/components/project/DetailsPanel';
import { MembersPanel } from '@/components/project/MembersPanel';
import { useProject } from '@/hooks/use-project';

const TABS = [
  { key: 'details', label: 'Details' },
  { key: 'members', label: 'Members' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function ProjectScreen() {
  const { id, tab: initialTab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const insets = useSafeAreaInsets();
  const { project, loading, failed, reload } = useProject(id);
  const [tab, setTab] = useState<TabKey>(initialTab === 'members' ? 'members' : 'details');

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
        {TABS.map(({ key, label }) => {
          const selected = tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setTab(key)}
              className="min-h-12 flex-1 items-center justify-center active:opacity-70">
              <Text
                className={
                  selected
                    ? 'font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark'
                    : 'font-manrope-semibold text-base text-text-secondary dark:text-text-secondary-dark'
                }>
                {label}
              </Text>
              {/* Accent marker on the selected tab, echoing the orange bar in the logo. */}
              <View
                className={`absolute bottom-0 h-0.5 w-full rounded-full ${selected ? 'bg-accent dark:bg-accent-dark' : 'bg-transparent'}`}
              />
            </Pressable>
          );
        })}
      </View>

      {tab === 'details' ? (
        <DetailsPanel project={project} loading={loading} failed={failed} reload={reload} />
      ) : (
        <MembersPanel projectId={id} />
      )}
    </View>
  );
}

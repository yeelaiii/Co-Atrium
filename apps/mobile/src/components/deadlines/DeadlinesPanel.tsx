import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, Text, View } from 'react-native';

import { useContract } from '@/hooks/use-contract';
import { useObligations } from '@/hooks/use-obligations';
import type { Obligation } from '@/lib/deadlines';
import { useTheme } from '@/theme/use-theme';

import { ObligationRow } from './ObligationRow';
import { cardClass, Disclaimer, PrimaryButton, SecondaryButton } from './ui';

/** The Deadlines tab of a project: what is overdue, suggested and coming up, plus logging events. */
export function DeadlinesPanel({ projectId }: { projectId: string }) {
  const theme = useTheme();
  const contract = useContract(projectId);
  const data = useObligations(projectId);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([contract.reload(), data.reload()]);
    setRefreshing(false);
  };

  const toCheck = contract.rules.filter((r) => r.status === 'draft').length;
  const sections = useMemo(() => {
    const g = data.groups;
    return [
      { key: 'overdue', title: 'Overdue', data: g.overdue },
      { key: 'suggested', title: 'Suggested: confirm if they apply', data: g.suggested },
      { key: 'week', title: 'Due in the next 7 days', data: g.thisWeek },
      { key: 'later', title: 'Later', data: g.later },
      { key: 'closed', title: 'Recently closed', data: g.closed.slice(0, 10) },
    ].filter((s) => s.data.length > 0);
  }, [data.groups]);

  const header = (
    <View className="gap-3 pb-2">
      {!contract.loading && !contract.live && (
        <View className={`${cardClass} gap-2 p-4`}>
          <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Deadlines are not live yet</Text>
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {contract.canConfirm
              ? `Confirm ${contract.missing.length} required contract value${contract.missing.length === 1 ? '' : 's'} first. Events you log now are kept and get deadlines once they're confirmed.`
              : 'A project QS, PM or contract administrator must confirm the contract values first. Project owners can give someone that role in Members.'}
          </Text>
        </View>
      )}
      {contract.live && toCheck > 0 && (
        <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          {toCheck} rule{toCheck === 1 ? '' : 's'} still to check. Only verified rules create deadlines.
        </Text>
      )}
      {contract.isStaff && (
        <PrimaryButton label="Log event" onPress={() => router.push({ pathname: '/project/[id]/deadlines/log-event', params: { id: projectId } })} />
      )}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <SecondaryButton icon="file" label="Contract" onPress={() => router.push({ pathname: '/project/[id]/contract', params: { id: projectId } })} />
        </View>
        <View className="flex-1">
          <SecondaryButton
            icon="list"
            label={toCheck ? `Rules (${toCheck})` : 'Rules'}
            onPress={() => router.push({ pathname: '/project/[id]/contract/rules', params: { id: projectId } })}
          />
        </View>
      </View>
    </View>
  );

  if ((data.loading || contract.loading) && !data.obligations.length) {
    return <ActivityIndicator color={theme.accent} className="mt-8" />;
  }

  return (
    <SectionList<Obligation, { key: string; title: string; data: Obligation[] }>
      sections={sections}
      keyExtractor={(o) => o.id}
      renderItem={({ item }) => <ObligationRow o={item} />}
      renderSectionHeader={({ section }) => (
        <Text accessibilityRole="header" className="bg-background pb-2 pt-4 font-manrope-semibold text-sm text-text-secondary dark:bg-background-dark dark:text-text-secondary-dark">
          {section.title} ({section.data.length})
        </Text>
      )}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Text className="mt-6 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          {data.failed ? 'Could not load deadlines. Pull down to try again.' : 'No deadlines yet. Log an RFI, payment claim or instruction to start.'}
        </Text>
      }
      ListFooterComponent={<Disclaimer />}
      contentContainerClassName="px-6 pb-10 pt-4"
      stickySectionHeadersEnabled={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.accent} colors={[theme.accent]} />}
    />
  );
}

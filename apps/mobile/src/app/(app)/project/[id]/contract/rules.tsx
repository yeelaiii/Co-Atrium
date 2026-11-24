import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, SectionList, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackLink, Disclaimer, PrimaryButton, StatusPill, Title } from '@/components/deadlines/ui';
import { useContract } from '@/hooks/use-contract';
import { fieldLabel } from '@/lib/contract-fields';
import { type DeadlineRule, eventLabel, ORIGIN_LABEL, PARTY_LABEL, rulePeriodText, TODO_LABEL } from '@/lib/deadlines';
import { useTheme } from '@/theme/use-theme';

const triggerText = (t: string) => (t === 'completion_date' ? 'Completion date' : t === 'chained' ? 'Follows another deadline' : eventLabel(t));

/** Rule review: TODO_VERIFY rules first, then drafts to verify, verified, rejected. */
export default function RulesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const c = useContract(id);

  const sections = useMemo(() => {
    const todo = c.rules.filter((r) => r.status === 'draft' && r.todo_verify.length > 0);
    const ready = c.rules.filter((r) => r.status === 'draft' && r.todo_verify.length === 0);
    return [
      { key: 'ready', title: 'Ready to verify', data: ready },
      { key: 'todo', title: 'Need values from the contract (TODO_VERIFY)', data: todo },
      { key: 'verified', title: 'Verified: creating deadlines', data: c.rules.filter((r) => r.status === 'verified') },
      { key: 'rejected', title: 'Rejected', data: c.rules.filter((r) => r.status === 'rejected') },
    ].filter((s) => s.data.length);
  }, [c.rules]);

  const renderRule = ({ item: r }: { item: DeadlineRule }) => (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/project/[id]/contract/rule/[ruleId]', params: { id, ruleId: r.id } })}
      className="mb-2 gap-1.5 rounded-card border border-border bg-surface px-4 py-3 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{r.obligation}</Text>
      <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
        {PARTY_LABEL[r.responsible_role]} · {rulePeriodText(r, fieldLabel)} after {triggerText(r.trigger_event_type).toLowerCase()}
      </Text>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{ORIGIN_LABEL[r.origin]}</Text>
        {r.status === 'verified' && <StatusPill status="met" label="Verified" />}
        {r.todo_verify.length > 0 && <StatusPill status="open" label={`Check ${r.todo_verify.map((t) => TODO_LABEL[t] ?? t).join(', ')}`} />}
        {r.is_time_bar && <StatusPill status="time_bar" />}
      </View>
    </Pressable>
  );

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.id}
        renderItem={renderRule}
        renderSectionHeader={({ section }) => (
          <Text accessibilityRole="header" className="bg-background pb-2 pt-5 font-manrope-semibold text-sm text-text-secondary dark:bg-background-dark dark:text-text-secondary-dark">
            {section.title} ({section.data.length})
          </Text>
        )}
        stickySectionHeadersEnabled={false}
        contentContainerClassName="px-6 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        ListHeaderComponent={
          <View>
            <BackLink />
            <Title subtitle="Only verified rules create deadlines. Standard form periods and clauses are TODO_VERIFY until someone enters them from your contract. Statute caps always apply.">
              Deadline rules
            </Title>
            {c.loading && <ActivityIndicator color={theme.accent} />}
            {c.canConfirm && (
              <PrimaryButton label="Add project rule" onPress={() => router.push({ pathname: '/project/[id]/contract/rule/[ruleId]', params: { id, ruleId: 'new' } })} />
            )}
          </View>
        }
        ListEmptyComponent={
          c.loading ? undefined : (
            <Text className="mt-4 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              No rules yet. Confirm the contract form on the Contract screen to load its standard rules.
            </Text>
          )
        }
        ListFooterComponent={<Disclaimer />}
      />
    </View>
  );
}

import { VO_CLOSED_STATUSES, VO_PENDING_STATUSES, type VoContractStatus } from '@shared/contracts/variations.ts';
import type { Party } from '@shared/deadlines/rules.ts';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackLink, cardClass, Disclaimer, SecondaryButton } from '@/components/deadlines/ui';
import { OptionSheet } from '@/components/OptionSheet';
import { ContractStatusPill } from '@/components/vo/ContractStatusPill';
import { useContract } from '@/hooks/use-contract';
import { usePaymentClaimRefs } from '@/hooks/use-payment-claim-refs';
import { useProject } from '@/hooks/use-project';
import { useVariationOrders } from '@/hooks/use-variation-orders';
import { PARTIES, PARTY_LABEL } from '@/lib/deadlines';
import { voCode, type VariationOrder } from '@/lib/variation-orders';
import {
  canShare,
  daysText,
  fetchProjectContractSum,
  formatMoney,
  type ProjectContractSum,
  registerCsv,
  registerHtml,
  registerTotals,
  shareCsv,
  sharePdf,
  voCurrentAmount,
} from '@/lib/vo-contract';
import { useTheme } from '@/theme/use-theme';

const STATUS_FILTERS: { key: string; label: string; match: (s: VoContractStatus) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'progress', label: 'In progress', match: (s) => VO_PENDING_STATUSES.includes(s) && s !== 'unconfirmed' },
  { key: 'unconfirmed', label: 'Unconfirmed', match: (s) => s === 'unconfirmed' },
  { key: 'agreed', label: 'Agreed', match: (s) => s === 'agreed' },
  { key: 'disputed', label: 'Disputed', match: (s) => s === 'disputed' },
  { key: 'closed', label: 'Rejected / withdrawn', match: (s) => VO_CLOSED_STATUSES.includes(s) },
];
const ANY_PARTY = 'Any party';

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-full border px-4 active:opacity-70 ${selected ? 'border-accent bg-surface dark:border-accent-dark dark:bg-surface-dark' : 'border-border dark:border-border-dark'}`}>
      <Text className={`font-manrope-semibold text-sm ${selected ? 'text-accent dark:text-accent-dark' : 'text-text-primary dark:text-text-primary-dark'}`}>{label}</Text>
    </Pressable>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3 py-1">
      <Text className="shrink font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{label}</Text>
      <Text className={`${strong ? 'font-manrope-bold text-base' : 'font-manrope-semibold text-sm'} text-text-primary dark:text-text-primary-dark`}>{value}</Text>
    </View>
  );
}

/** VO register: every VO you can see, with filters, totals and export. */
export default function VoRegister() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { project } = useProject(id);
  const contract = useContract(id);
  const { variationOrders, loading, failed, reload } = useVariationOrders(id);
  const claimRefs = usePaymentClaimRefs(id);

  const [statusFilter, setStatusFilter] = useState('all');
  const [party, setParty] = useState<Party | null>(null);
  const [timeOnly, setTimeOnly] = useState(false);
  const [partySheet, setPartySheet] = useState(false);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const [projectSum, setProjectSum] = useState<ProjectContractSum | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (contract.canConfirm) fetchProjectContractSum(id).then(setProjectSum);
    }, [id, contract.canConfirm]),
  );

  const sumField = contract.fields.get('contract_sum');
  const original = sumField && !sumField.not_stated ? (sumField.value as { amount: number; currency?: string }) : null;
  const currency = projectSum?.currency ?? original?.currency ?? 'SGD';

  const rows = useMemo(() => {
    const match = STATUS_FILTERS.find((f) => f.key === statusFilter)!.match;
    return [...variationOrders]
      .filter((vo) => match(vo.contract.status))
      .filter((vo) => !party || vo.contract.instructingParty === party)
      .filter((vo) => !timeOnly || (vo.contract.timeClaimed ?? 0) > 0 || (vo.contract.timeAgreed ?? 0) > 0)
      .sort((a, b) => b.number - a.number);
  }, [variationOrders, statusFilter, party, timeOnly]);

  const totals = useMemo(() => registerTotals(rows, null), [rows]);
  const filtered = statusFilter !== 'all' || !!party || timeOnly;
  const filterNote = [
    STATUS_FILTERS.find((f) => f.key === statusFilter)!.label,
    party ? `instructed by ${PARTY_LABEL[party]}` : null,
    timeOnly ? 'with time impact' : null,
  ].filter(Boolean).join(', ') + ` · ${rows.length} VO${rows.length === 1 ? '' : 's'} you can see`;

  const exportAs = async (kind: 'csv' | 'pdf') => {
    if (!(await canShare())) return Alert.alert('Sharing is not available on this device.');
    setExporting(kind);
    try {
      const data = rows.map((vo) => ({ vo, paymentClaims: claimRefs.get(vo.id) ?? [] }));
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'csv') await shareCsv(registerCsv(data), `vo-register-${stamp}.csv`);
      else await sharePdf(registerHtml({ projectName: project?.name ?? 'Project', rows: data, totals, currency, filterNote }));
    } catch {
      Alert.alert('Could not export', 'Try again.');
    } finally {
      setExporting(null);
    }
  };

  const header = (
    <View>
      <BackLink />
      <Text accessibilityRole="header" className="mt-2 font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">VO register</Text>
      <Text className="mb-3 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
        Contractual status and amounts of the variation orders shared with you.
      </Text>

      {contract.canConfirm && projectSum && (
        <View className={`${cardClass} mb-3 p-4`}>
          <Text className="mb-1 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Contract sum (all {projectSum.vo_count} VOs)</Text>
          {projectSum.original === null ? (
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              Confirm the contract sum under Contract values to see the revised sum.
            </Text>
          ) : (
            <>
              <Total label="Original" value={formatMoney(projectSum.original, currency)} />
              <Total label="Agreed variations" value={formatMoney(projectSum.agreed, currency)} />
              <Total label="Revised contract sum" value={formatMoney(projectSum.revised, currency)} strong />
              <Total label="Incl. pending VOs (estimate: assessed, else claimed)" value={formatMoney(projectSum.revised_incl_pending, currency)} />
            </>
          )}
          {projectSum.disputed !== 0 && <Total label="Disputed (not included)" value={formatMoney(projectSum.disputed, currency)} />}
          {projectSum.unpriced_count > 0 && (
            <Text className="mt-1 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              {projectSum.unpriced_count} VO{projectSum.unpriced_count === 1 ? ' has' : 's have'} no amount yet and {projectSum.unpriced_count === 1 ? 'is' : 'are'} left out of the estimate.
            </Text>
          )}
        </View>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 pb-2">
        {STATUS_FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} selected={statusFilter === f.key} onPress={() => setStatusFilter(f.key)} />
        ))}
      </ScrollView>
      <View className="flex-row gap-2 pb-3">
        <Chip label={party ? PARTY_LABEL[party] : ANY_PARTY} selected={!!party} onPress={() => setPartySheet(true)} />
        <Chip label="Has time impact" selected={timeOnly} onPress={() => setTimeOnly((t) => !t)} />
      </View>

      <View className={`${cardClass} mb-3 p-4`}>
        <Text className="mb-1 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">{filtered ? 'Totals (filtered)' : 'Totals'}</Text>
        <Total label="Agreed" value={formatMoney(totals.agreed, currency)} />
        <Total label="Pending (assessed, else claimed)" value={formatMoney(totals.pending, currency)} />
        <Total label="Disputed" value={formatMoney(totals.disputed, currency)} />
        {totals.unpriced > 0 && (
          <Text className="mt-1 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{totals.unpriced} without an amount yet.</Text>
        )}
      </View>

      <View className="mb-4 flex-row gap-2">
        <View className="flex-1">
          <SecondaryButton icon="list" label={exporting === 'csv' ? 'Exporting…' : 'Export CSV'} disabled={!!exporting || rows.length === 0} onPress={() => exportAs('csv')} />
        </View>
        <View className="flex-1">
          <SecondaryButton icon="file" label={exporting === 'pdf' ? 'Exporting…' : 'Export PDF'} disabled={!!exporting || rows.length === 0} onPress={() => exportAs('pdf')} />
        </View>
      </View>
      {failed && (
        <Text accessibilityRole="alert" className="mb-3 font-manrope text-sm text-red-700 dark:text-red-400">
          Error: Could not load variation orders. Pull down to try again.
        </Text>
      )}
    </View>
  );

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top + 16 }}>
      <FlatList
        data={rows}
        keyExtractor={(vo) => vo.id}
        ListHeaderComponent={header}
        renderItem={({ item }) => <RegisterRow vo={item} currency={currency} claims={claimRefs.get(item.id) ?? []} projectId={id} />}
        ItemSeparatorComponent={() => <View className="h-2" />}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={theme.accent} />
          ) : (
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              {filtered ? 'No variation orders match these filters.' : 'No variation orders yet.'}
            </Text>
          )
        }
        ListFooterComponent={<Disclaimer />}
        contentContainerClassName="px-6"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={theme.accent} colors={[theme.accent]} />}
      />
      <OptionSheet
        visible={partySheet}
        title="Instructed by"
        options={[ANY_PARTY, ...PARTIES.map((p) => PARTY_LABEL[p])]}
        selected={party ? PARTY_LABEL[party] : ANY_PARTY}
        onSelect={(o) => {
          setParty(PARTIES.find((p) => PARTY_LABEL[p] === o) ?? null);
          setPartySheet(false);
        }}
        onClose={() => setPartySheet(false)}
      />
    </View>
  );
}

function RegisterRow({ vo, currency, claims, projectId }: { vo: VariationOrder; currency: string; claims: string[]; projectId: string }) {
  const c = vo.contract;
  const amount = voCurrentAmount(vo);
  const time = c.timeAgreed ?? c.timeClaimed;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${voCode(vo)}, ${vo.name}, ${c.status.replace('_', ' ')}, ${formatMoney(amount, currency)}. Open`}
      onPress={() => router.push({ pathname: '/project/[id]/vo/contract/[voId]', params: { id: projectId, voId: vo.id } })}
      className={`${cardClass} gap-2 px-4 py-3 active:opacity-70`}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-manrope-bold text-xs text-text-secondary dark:text-text-secondary-dark">
            {voCode(vo)}{c.instructionReference ? ` · ${c.instructionReference}` : ''}
          </Text>
          <Text numberOfLines={2} className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{vo.name}</Text>
        </View>
        <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">{formatMoney(amount, currency)}</Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <ContractStatusPill status={c.status} />
        {c.isOmission && <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">Omission</Text>}
        {time !== null && time > 0 && (
          <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
            {daysText(time)} {c.timeAgreed !== null ? 'agreed' : 'claimed'}
          </Text>
        )}
        {c.status === 'agreed' && (
          <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
            {claims.length ? `In ${claims.join(', ')}` : 'Not yet claimed'}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

import { CONTRACT_FIELDS, REQUIRED_FIELDS, SECTION_LABEL, type FieldDef, type FieldSection } from '@shared/contracts/contractFieldSchema.ts';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackLink, cardClass, Disclaimer, ErrorText, inputClass, SecondaryButton, StatusPill, Title } from '@/components/deadlines/ui';
import { type ContractField, useContract } from '@/hooks/use-contract';
import { useContractDocuments } from '@/hooks/use-contract-documents';
import { formatFieldValue } from '@/lib/contract-fields';
import { deadlineErrorMessage } from '@/lib/deadlines';
import { useTheme } from '@/theme/use-theme';

const REQUIRED_KEYS = new Set(REQUIRED_FIELDS.flatMap((r) => (typeof r === 'string' ? [r] : [...r])));
const SECTIONS = Object.keys(SECTION_LABEL) as FieldSection[];

const ORIGIN: Record<ContractField['origin'], string> = {
  extracted: 'from document',
  standard_form_default: 'standard form default',
  user_entered: 'entered',
};

/** Confirmed contract values, grouped by section, with the required ones first. */
export default function ContractScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const c = useContract(id);
  const docs = useContractDocuments(id);
  const [refreshing, setRefreshing] = useState(false);

  const sections = useMemo(() => {
    const req = CONTRACT_FIELDS.filter((d) => REQUIRED_KEYS.has(d.key));
    return [
      { key: 'required', title: 'Required before deadlines go live', data: req },
      ...SECTIONS.map((s) => ({ key: s, title: SECTION_LABEL[s], data: CONTRACT_FIELDS.filter((d) => d.section === s && !REQUIRED_KEYS.has(d.key)) })),
    ];
  }, []);

  const open = (key: string) => router.push({ pathname: '/project/[id]/contract/field/[key]', params: { id, key } });

  const renderField = ({ item, index, section }: { item: FieldDef; index: number; section: { data: FieldDef[] } }) => {
    const f = c.fields.get(item.key);
    const value = f ? (f.not_stated ? 'Not stated in the contract' : formatFieldValue(item, f.value)) : null;
    const first = index === 0;
    const last = index === section.data.length - 1;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.label}: ${value ?? 'not confirmed'}${c.canConfirm ? '. Edit' : ''}`}
        disabled={!c.canConfirm}
        onPress={() => open(item.key)}
        className={`min-h-14 gap-1 border-x border-border bg-surface px-4 py-3 active:opacity-70 dark:border-border-dark dark:bg-surface-dark ${first ? 'rounded-t-card border-t' : ''} ${last ? 'rounded-b-card border-b' : 'border-b'}`}>
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">{item.label}</Text>
          {f ? <StatusPill status="met" label="Confirmed" /> : REQUIRED_KEYS.has(item.key) ? <StatusPill status="open" label="Needed" /> : null}
        </View>
        <Text className={`font-manrope text-base ${value ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
          {value ?? 'Not confirmed'}
        </Text>
        {f && <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{ORIGIN[f.origin]}{f.source_page ? `, page ${f.source_page}` : ''}</Text>}
      </Pressable>
    );
  };

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <SectionList
        sections={sections}
        keyExtractor={(d) => d.key}
        renderItem={renderField}
        renderSectionHeader={({ section }) => (
          <Text accessibilityRole="header" className="bg-background pb-2 pt-5 font-manrope-semibold text-sm text-text-secondary dark:bg-background-dark dark:text-text-secondary-dark">
            {section.title}
          </Text>
        )}
        stickySectionHeadersEnabled={false}
        contentContainerClassName="px-6 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await Promise.all([c.reload(), docs.reload()]);
              setRefreshing(false);
            }}
            tintColor={theme.accent}
            colors={[theme.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            <BackLink />
            <Title
              subtitle={
                c.live
                  ? 'Deadlines are live. Changing a value recalculates open deadlines.'
                  : c.canConfirm
                    ? `Confirm ${c.missing.length} more required value${c.missing.length === 1 ? '' : 's'} to switch deadlines on.`
                    : 'Only a project QS, PM or contract administrator can confirm these values.'
              }>
              Contract
            </Title>
            {c.loading && <ActivityIndicator color={theme.accent} />}
            <View className="gap-2">
              {c.isStaff && (
                <SecondaryButton
                  icon="file"
                  label={docs.documents.length ? `Contract documents (${docs.documents.length})` : 'Upload contract documents'}
                  onPress={() => router.push({ pathname: '/project/[id]/contract/documents', params: { id } })}
                />
              )}
              {docs.toReview > 0 && (
                <SecondaryButton
                  icon="alert"
                  label={`Review extracted values (${docs.toReview} document${docs.toReview === 1 ? '' : 's'})`}
                  onPress={() => router.push({ pathname: '/project/[id]/contract/review', params: { id } })}
                />
              )}
              <SecondaryButton icon="list" label="Deadline rules" onPress={() => router.push({ pathname: '/project/[id]/contract/rules', params: { id } })} />
              <SecondaryButton
                icon="file"
                label={c.canConfirm ? 'VO register and revised contract sum' : 'VO register'}
                onPress={() => router.push({ pathname: '/project/[id]/vo/register', params: { id } })}
              />
            </View>
          </View>
        }
        ListFooterComponent={
          <View>
            <ServiceSettings contract={c} />
            <Disclaimer />
          </View>
        }
      />
    </View>
  );
}

/** Service cut-off time and whether Saturday is a working day (migration 0020 defaults: 17:00, no). */
function ServiceSettings({ contract: c }: { contract: ReturnType<typeof useContract> }) {
  const theme = useTheme();
  const current = c.settings?.service_cutoff?.slice(0, 5) ?? '17:00';
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = cutoff ?? current;
  const saturday = c.settings?.saturday_is_working_day ?? false;
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(shown);

  const save = async (nextCutoff: string, nextSaturday: boolean) => {
    setError(null);
    const err = await c.updateSettings(nextCutoff, nextSaturday);
    if (err) setError(deadlineErrorMessage(err));
    else setCutoff(null);
  };

  return (
    <View className="mt-6">
      <Text accessibilityRole="header" className="mb-2 font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
        When documents count as served
      </Text>
      <View className={`${cardClass} gap-3 p-4`}>
        <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          Sent on a working day before the cut-off: served that day. Otherwise: the next working day. Working days exclude Singapore public holidays.
        </Text>
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Cut-off (SGT)</Text>
          <TextInput
            accessibilityLabel="Service cut-off time, HH:MM"
            editable={c.canConfirm}
            value={shown}
            onChangeText={setCutoff}
            onEndEditing={() => cutoff !== null && valid && cutoff !== current && save(cutoff, saturday)}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            className={`${inputClass} w-24 text-center`}
          />
        </View>
        <View className="min-h-11 flex-row items-center gap-3">
          <Text className="flex-1 font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Saturday is a working day</Text>
          <Switch
            accessibilityLabel="Saturday is a working day"
            disabled={!c.canConfirm}
            value={saturday}
            onValueChange={(v) => save(valid ? shown : current, v)}
            trackColor={{ true: theme.accent }}
          />
        </View>
        {!valid && <Text className="font-manrope text-xs text-red-700 dark:text-red-400">Use HH:MM, for example 17:00.</Text>}
        <ErrorText message={error} />
      </View>
    </View>
  );
}

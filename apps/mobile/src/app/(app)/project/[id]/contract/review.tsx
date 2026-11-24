import { FIELD_BY_KEY, REQUIRED_FIELDS, SECTION_LABEL, type FieldDef, type FieldSection } from '@shared/contracts/contractFieldSchema.ts';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, ConfidenceBadge } from '@/components/contract/badges';
import { BackLink, cardClass, Disclaimer, ErrorText, PrimaryButton, SecondaryButton, Title } from '@/components/deadlines/ui';
import { type ContractField, useContract } from '@/hooks/use-contract';
import { useContractDocuments, useExtractedFields } from '@/hooks/use-contract-documents';
import { documentErrorMessage, type ExtractedField, type ExtractionFinding, NOT_FOUND_LABEL } from '@/lib/contract-documents';
import { formatFieldValue } from '@/lib/contract-fields';
import { useTheme } from '@/theme/use-theme';

const REQUIRED_KEYS = new Set(REQUIRED_FIELDS.flatMap((r) => (typeof r === 'string' ? [r] : [...r])));
const SECTIONS = Object.keys(SECTION_LABEL) as FieldSection[];

type Row = { kind: 'field'; f: ExtractedField; def: FieldDef } | { kind: 'finding'; x: ExtractionFinding };

/**
 * Extracted values waiting for a person: values to check (low confidence or not found) first,
 * then the rest by section. Accept, edit or reject each one, or accept every high-confidence
 * value at once. A value that differs from the confirmed one shows both, with sources.
 */
export default function ReviewExtractedFields() {
  const { id, documentId } = useLocalSearchParams<{ id: string; documentId?: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const contract = useContract(id);
  const docs = useContractDocuments(id);
  const ex = useExtractedFields(id, documentId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const threshold = Number(contract.settings?.high_confidence_threshold ?? 0.9);

  // Latest open proposal per field (rows arrive newest first).
  const { open, unchanged } = useMemo(() => {
    const seen = new Set<string>();
    const open: ExtractedField[] = [];
    let unchanged = 0;
    for (const f of ex.fields) {
      if (f.status === 'no_change') {
        unchanged++;
        continue;
      }
      if (seen.has(f.field_key) || !FIELD_BY_KEY.has(f.field_key)) continue;
      seen.add(f.field_key);
      open.push(f);
    }
    return { open, unchanged };
  }, [ex.fields]);

  const needsCheck = (f: ExtractedField) => f.value === null || Number(f.confidence) < threshold;
  const highIds = open.filter((f) => !needsCheck(f)).map((f) => f.id);

  const sections = useMemo(() => {
    const row = (f: ExtractedField): Row => ({ kind: 'field', f, def: FIELD_BY_KEY.get(f.field_key)! });
    const check = open.filter(needsCheck).sort((a, b) =>
      Number(REQUIRED_KEYS.has(b.field_key)) - Number(REQUIRED_KEYS.has(a.field_key)) ||
      Number(a.value !== null) - Number(b.value !== null) ||
      Number(a.confidence) - Number(b.confidence)
    );
    const out: { key: string; title: string; data: Row[] }[] = [];
    if (check.length) out.push({ key: 'check', title: `Check these first (${check.length})`, data: check.map(row) });
    for (const s of SECTIONS) {
      const data = open.filter((f) => !needsCheck(f) && FIELD_BY_KEY.get(f.field_key)!.section === s).map(row);
      if (data.length) out.push({ key: s, title: SECTION_LABEL[s], data });
    }
    if (ex.findings.length) {
      out.push({ key: 'findings', title: 'Other changes found', data: ex.findings.map((x) => ({ kind: 'finding' as const, x })) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ex.findings, threshold]);

  const docIds = useMemo(() => new Set(documentId ? [documentId] : docs.documents.map((d) => d.id)), [documentId, docs.documents]);
  const draftRules = contract.rules.filter((r) => r.status === 'draft' && r.source_document_id && docIds.has(r.source_document_id));
  const docName = documentId ? docs.documents.find((d) => d.id === documentId)?.filename : null;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    const err = await fn();
    setBusy(null);
    if (err) setError(documentErrorMessage(err));
    else {
      Haptics.selectionAsync();
      contract.reload();
    }
  };

  const acceptAll = () =>
    act('all', async () => {
      const { error } = await ex.confirmMany(highIds);
      return error;
    });

  const renderItem = ({ item }: { item: Row }) =>
    item.kind === 'finding'
      ? <FindingCard x={item.x} projectId={id} canConfirm={contract.canConfirm} busy={busy === item.x.id} onDismiss={() => act(item.x.id, () => ex.dismissFinding(item.x.id))} />
      : (
        <ProposalCard
          f={item.f}
          def={item.def}
          current={contract.fields.get(item.f.field_key)}
          threshold={threshold}
          projectId={id}
          canConfirm={contract.canConfirm}
          busy={busy === item.f.id}
          onAccept={() => act(item.f.id, () => ex.confirm(item.f.id))}
          onNotStated={() => act(item.f.id, () => ex.confirm(item.f.id, null, true))}
          onReject={() => act(item.f.id, () => ex.reject(item.f.id))}
        />
      );

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <SectionList
        sections={sections}
        keyExtractor={(r) => (r.kind === 'field' ? r.f.id : r.x.id)}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text accessibilityRole="header" className="bg-background pb-2 pt-5 font-manrope-semibold text-sm text-text-secondary dark:bg-background-dark dark:text-text-secondary-dark">
            {section.title}
          </Text>
        )}
        ItemSeparatorComponent={() => <View className="h-3" />}
        stickySectionHeadersEnabled={false}
        contentContainerClassName="px-6 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await Promise.all([ex.reload(), contract.reload()]);
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
              subtitle={[
                docName ? `From ${docName}.` : null,
                contract.canConfirm
                  ? 'Check each value against its source before accepting it. Nothing is used until you accept it.'
                  : 'Only a project QS, PM or contract administrator can accept these values.',
              ].filter(Boolean).join(' ')}>
              Review extracted values
            </Title>
            {(ex.loading || contract.loading) && <ActivityIndicator color={theme.accent} />}
            {ex.failed && <ErrorText message="Proposals could not be loaded. Pull to retry." />}
            {contract.canConfirm && highIds.length > 0 && (
              <PrimaryButton
                label={`Accept ${highIds.length} high-confidence value${highIds.length === 1 ? '' : 's'} (≥ ${Math.round(threshold * 100)}%)`}
                onPress={acceptAll}
                busy={busy === 'all'}
              />
            )}
            <ErrorText message={error} />
            {!ex.loading && !open.length && !ex.findings.length && (
              <Text className="mt-4 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Nothing waiting for review.</Text>
            )}
            {unchanged > 0 && (
              <Text className="mt-3 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                {unchanged} value{unchanged === 1 ? ' matches' : 's match'} what is already confirmed: no change needed.
              </Text>
            )}
            {draftRules.length > 0 && (
              <View className={`${cardClass} mt-4 gap-2 p-4`}>
                <Badge tone="info" icon="list" label={`${draftRules.length} draft rule${draftRules.length === 1 ? '' : 's'}`} />
                <Text className="font-manrope text-sm text-text-primary dark:text-text-primary-dark">
                  Amended periods and project procedures were found. They become deadlines only once verified.
                </Text>
                <SecondaryButton icon="list" label="Review draft rules" onPress={() => router.push({ pathname: '/project/[id]/contract/rules', params: { id } })} />
              </View>
            )}
          </View>
        }
        ListFooterComponent={<Disclaimer />}
      />
    </View>
  );
}

function SmallButton({ label, onPress, disabled, tone = 'plain' }: { label: string; onPress: () => void; disabled?: boolean; tone?: 'plain' | 'accent' }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 min-w-11 items-center justify-center rounded-button border px-3 ${tone === 'accent' ? 'border-accent dark:border-accent-dark' : 'border-border dark:border-border-dark'} ${disabled ? 'opacity-40' : 'active:opacity-70'}`}>
      <Text className={`font-manrope-semibold text-sm ${tone === 'accent' ? 'text-accent dark:text-accent-dark' : 'text-text-primary dark:text-text-primary-dark'}`}>{label}</Text>
    </Pressable>
  );
}

function Source({ projectId, documentId, page, excerpt }: { projectId: string; documentId: string; page: number | null; excerpt: string | null }) {
  if (!page) return null;
  return (
    <View className="gap-1">
      {excerpt && <Text className="font-manrope text-sm italic text-text-secondary dark:text-text-secondary-dark">“{excerpt}”</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View source, page ${page}`}
        hitSlop={8}
        onPress={() => router.push({ pathname: '/project/[id]/contract/source', params: { id: projectId, documentId, page: String(page), excerpt: excerpt ?? '' } })}
        className="min-h-11 justify-center self-start active:opacity-70">
        <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">View source · page {page} ›</Text>
      </Pressable>
    </View>
  );
}

function ProposalCard(props: {
  f: ExtractedField;
  def: FieldDef;
  current: ContractField | undefined;
  threshold: number;
  projectId: string;
  canConfirm: boolean;
  busy: boolean;
  onAccept: () => void;
  onNotStated: () => void;
  onReject: () => void;
}) {
  const { f, def, current, projectId } = props;
  const found = f.value !== null;
  const required = REQUIRED_KEYS.has(def.key);
  const proposed = found ? formatFieldValue(def, f.value) : null;
  const now = current ? (current.not_stated ? 'Not stated in the contract' : formatFieldValue(def, current.value)) : null;
  const disabled = !props.canConfirm || props.busy;
  const edit = () => router.push({ pathname: '/project/[id]/contract/field/[key]', params: { id: projectId, key: def.key, proposal: f.id } });

  return (
    <View className={`${cardClass} gap-2 p-4`}>
      <View className="flex-row items-start justify-between gap-2">
        <Text className="flex-1 font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{def.label}</Text>
        {required && <Badge tone="neutral" icon="flag" label="Required" />}
      </View>

      {found ? (
        <>
          {now !== null ? (
            <View className="gap-1">
              <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">Now: {now}{current?.source_page ? ` (page ${current.source_page})` : ''}</Text>
              <Text className="font-manrope-bold text-base text-text-primary dark:text-text-primary-dark">Proposed: {proposed}</Text>
            </View>
          ) : (
            <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">{proposed}</Text>
          )}
          <ConfidenceBadge confidence={Number(f.confidence)} threshold={props.threshold} />
          <Source projectId={projectId} documentId={f.document_id} page={f.page_no} excerpt={f.source_excerpt} />
        </>
      ) : (
        <>
          <Badge tone="warning" icon="alert" label={NOT_FOUND_LABEL[f.not_found_reason ?? 'not_found']} />
          {now !== null && <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Confirmed: {now}</Text>}
          {required && !now && (
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Needed before deadlines go live: enter it, or confirm the contract doesn’t state it.</Text>
          )}
        </>
      )}

      {props.canConfirm && (
        <View className="mt-1 flex-row flex-wrap gap-2">
          {found ? (
            <>
              <SmallButton tone="accent" label={props.busy ? 'Saving…' : 'Accept'} onPress={props.onAccept} disabled={disabled} />
              <SmallButton label="Edit" onPress={edit} disabled={disabled} />
              <SmallButton label="Reject" onPress={props.onReject} disabled={disabled} />
            </>
          ) : (
            <>
              <SmallButton tone="accent" label="Enter value" onPress={edit} disabled={disabled} />
              {def.key !== 'contract_form' && <SmallButton label="Not stated" onPress={props.onNotStated} disabled={disabled} />}
              <SmallButton label="Skip" onPress={props.onReject} disabled={disabled} />
            </>
          )}
        </View>
      )}
    </View>
  );
}

function FindingCard({ x, projectId, canConfirm, busy, onDismiss }: { x: ExtractionFinding; projectId: string; canConfirm: boolean; busy: boolean; onDismiss: () => void }) {
  return (
    <View className={`${cardClass} gap-2 p-4`}>
      <Badge tone="info" icon="file" label={x.kind === 'amendment' ? `Amendment${x.clause ? `, clause ${x.clause}` : ''}` : 'Project procedure'} />
      <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">{x.summary}</Text>
      <Source projectId={projectId} documentId={x.document_id} page={x.page_no} excerpt={x.source_excerpt} />
      <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
        Not turned into a deadline automatically. Add a rule for it if it needs one.
      </Text>
      {canConfirm && (
        <View className="flex-row flex-wrap gap-2">
          <SmallButton label="Add a rule" onPress={() => router.push({ pathname: '/project/[id]/contract/rule/[ruleId]', params: { id: projectId, ruleId: 'new' } })} />
          <SmallButton label={busy ? 'Saving…' : 'Dismiss'} onPress={onDismiss} disabled={busy} />
        </View>
      )}
    </View>
  );
}

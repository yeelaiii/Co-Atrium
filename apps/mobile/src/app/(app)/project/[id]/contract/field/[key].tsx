import { FIELD_BY_KEY, validateFieldValue, type FieldDef } from '@shared/contracts/contractFieldSchema.ts';
import { PERIOD_UNITS, unitLabel } from '@shared/deadlines/calculator.ts';
import { sgtInstant, toSgt } from '@shared/deadlines/calendar.ts';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DateTimeField } from '@/components/deadlines/DateTimeField';
import { BackLink, cardClass, Disclaimer, ErrorText, inputClass, Label, PrimaryButton, Title } from '@/components/deadlines/ui';
import { useContract } from '@/hooks/use-contract';
import { type ExtractedField, NOT_FOUND_LABEL } from '@/lib/contract-documents';
import { enumLabel, formatFieldValue } from '@/lib/contract-fields';
import { deadlineErrorMessage, requestRecalculation } from '@/lib/deadlines';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme/use-theme';

// deno-lint-ignore no-explicit-any
type Any = any;

/** Radio list (enum, units, yes/no). The selected row carries the accent marker. */
function Choice<T extends string>({ options, value, onChange, label }: { options: readonly T[]; value: T | null; onChange: (v: T) => void; label: (v: T) => string }) {
  return (
    <View className={`${cardClass} overflow-hidden`}>
      {options.map((o, i) => {
        const active = o === value;
        return (
          <Pressable
            key={o}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o)}
            className={`min-h-12 flex-row items-center gap-3 px-4 active:opacity-70 ${i < options.length - 1 ? 'border-b border-border dark:border-border-dark' : ''}`}>
            <View className={`h-6 w-1.5 rounded-full ${active ? 'bg-accent dark:bg-accent-dark' : 'bg-transparent'}`} />
            <Text className={`flex-1 text-base text-text-primary dark:text-text-primary-dark ${active ? 'font-manrope-bold' : 'font-manrope'}`}>{label(o)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(/,/g, '')));

/** Builds the editing state for a field kind from its current value. */
function initialDraft(def: FieldDef, v: Any): Record<string, Any> {
  switch (def.kind) {
    case 'money':
      return { amount: v?.amount?.toString() ?? '', currency: v?.currency ?? 'SGD' };
    case 'percent':
    case 'day_of_month':
      return { n: v?.toString() ?? '' };
    case 'period':
      return { n: v?.value?.toString() ?? '', unit: v?.unit ?? 'calendar_days' };
    case 'percent_or_amount':
      return { kind: v?.kind ?? 'percent', n: v?.value?.toString() ?? '', currency: v?.currency ?? 'SGD' };
    case 'ld_rate':
      return { amount: v?.amount?.toString() ?? '', currency: v?.currency ?? 'SGD', per: v?.per ?? 'day' };
    case 'text_list':
      return { text: Array.isArray(v) ? v.join('\n') : '' };
    case 'object':
    case 'object_list':
      return { json: v === undefined || v === null ? '' : JSON.stringify(v, null, 2) };
    case 'date':
      return { date: typeof v === 'string' ? v : toSgt(new Date()).date };
    default:
      return { v: v ?? null };
  }
}

/** Turns the editing state back into the JSON value the schema expects. */
function buildValue(def: FieldDef, d: Record<string, Any>): unknown {
  switch (def.kind) {
    case 'money':
      return { amount: num(d.amount), currency: d.currency.trim().toUpperCase() || 'SGD' };
    case 'percent':
    case 'day_of_month':
      return num(d.n);
    case 'period':
      return { value: num(d.n), unit: d.unit };
    case 'percent_or_amount':
      return d.kind === 'percent' ? { kind: 'percent', value: num(d.n) } : { kind: 'amount', value: num(d.n), currency: d.currency || 'SGD' };
    case 'ld_rate':
      return { amount: num(d.amount), currency: d.currency.trim().toUpperCase() || 'SGD', per: d.per };
    case 'text_list':
      return String(d.text).split('\n').map((s) => s.trim()).filter(Boolean);
    case 'object':
    case 'object_list':
      try {
        return JSON.parse(d.json);
      } catch {
        return undefined;
      }
    case 'date':
      return d.date;
    case 'text':
      return typeof d.v === 'string' ? d.v.trim() : d.v;
    default:
      return d.v;
  }
}

/**
 * Edits one contract value. With `proposal` (an extracted_fields id) it starts from the
 * extracted value and confirms through confirm_extracted_field, keeping the source citation.
 */
export default function EditContractField() {
  const { id, key, proposal: proposalId } = useLocalSearchParams<{ id: string; key: string; proposal?: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const c = useContract(id);
  const def = FIELD_BY_KEY.get(key);
  const current = c.fields.get(key);
  const [draft, setDraft] = useState<Record<string, Any> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ExtractedField | null>(null);

  useEffect(() => {
    if (!proposalId) return;
    let live = true;
    supabase.from('extracted_fields').select('*').eq('id', proposalId).maybeSingle().then(({ data }) => {
      if (live && data) setProposal(data as ExtractedField);
    });
    return () => {
      live = false;
    };
  }, [proposalId]);

  if (!def) {
    return (
      <View className="flex-1 bg-background px-6 dark:bg-background-dark" style={{ paddingTop: insets.top + 16 }}>
        <BackLink />
        <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Unknown field.</Text>
      </View>
    );
  }

  const start = proposal?.value ?? (current?.not_stated ? undefined : current?.value);
  const d = draft ?? initialDraft(def, start);
  const set = (patch: Record<string, Any>) => setDraft({ ...d, ...patch });
  const value = buildValue(def, d);
  const check = value === undefined ? { ok: false as const, error: 'Not valid JSON' } : validateFieldValue(def.key, value);

  const save = async (notStated: boolean) => {
    if (!notStated && !check.ok) return;
    setSaving(true);
    setError(null);
    const v = notStated ? null : (check as { value: unknown }).value;
    let err: unknown;
    if (proposal) {
      // Unchanged from the extracted value: confirm as extracted; otherwise as the reviewer's edit.
      const edited = notStated || JSON.stringify(v) === JSON.stringify(proposal.value) ? null : v;
      ({ error: err } = await supabase.rpc('confirm_extracted_field', { fid: proposal.id, edited, not_stated: notStated }));
      if (!err) requestRecalculation(id);
    } else {
      err = await c.setField(def.key, v, notStated);
    }
    setSaving(false);
    if (err) return setError(deadlineErrorMessage(err));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const numberInput = (label: string, field: string, keyboard: 'decimal-pad' | 'number-pad' = 'decimal-pad') => (
    <TextInput accessibilityLabel={label} value={d[field]} onChangeText={(t) => set({ [field]: t })} keyboardType={keyboard} placeholder={label} placeholderTextColor={theme.textSecondary} className={inputClass} />
  );

  const editor = (() => {
    switch (def.kind) {
      case 'enum':
        return <Choice options={def.options as string[]} value={d.v} onChange={(v) => set({ v })} label={enumLabel} />;
      case 'boolean':
        return <Choice options={['yes', 'no'] as const} value={d.v === null ? null : d.v ? 'yes' : 'no'} onChange={(v) => set({ v: v === 'yes' })} label={(v) => (v === 'yes' ? 'Yes' : 'No')} />;
      case 'date':
        return <DateTimeField mode="date" accessibilityLabel={def.label} value={sgtInstant(d.date, 12 * 60)} onChange={(dt) => set({ date: toSgt(dt).date })} />;
      case 'money':
        return (
          <View className="flex-row gap-2">
            <View className="w-24"><TextInput accessibilityLabel="Currency" value={d.currency} onChangeText={(t) => set({ currency: t })} autoCapitalize="characters" maxLength={3} className={inputClass} /></View>
            <View className="flex-1">{numberInput('Amount', 'amount')}</View>
          </View>
        );
      case 'percent':
        return numberInput('Percent', 'n');
      case 'day_of_month':
        return numberInput('Day of month (1–31)', 'n', 'number-pad');
      case 'period':
        return (
          <View className="gap-3">
            {numberInput('Number', 'n', 'number-pad')}
            <Choice options={PERIOD_UNITS} value={d.unit} onChange={(unit) => set({ unit })} label={(u) => unitLabel(u, 2)} />
          </View>
        );
      case 'percent_or_amount':
        return (
          <View className="gap-3">
            <Choice options={['percent', 'amount'] as const} value={d.kind} onChange={(kind) => set({ kind })} label={(k) => (k === 'percent' ? 'Percentage' : 'Amount')} />
            {numberInput(d.kind === 'percent' ? 'Percent' : 'Amount', 'n')}
          </View>
        );
      case 'ld_rate':
        return (
          <View className="gap-3">
            <View className="flex-row gap-2">
              <View className="w-24"><TextInput accessibilityLabel="Currency" value={d.currency} onChangeText={(t) => set({ currency: t })} autoCapitalize="characters" maxLength={3} className={inputClass} /></View>
              <View className="flex-1">{numberInput('Amount', 'amount')}</View>
            </View>
            <Choice options={['day', 'week'] as const} value={d.per} onChange={(per) => set({ per })} label={(p) => `Per ${p}`} />
          </View>
        );
      case 'text_list':
        return <TextInput accessibilityLabel={def.label} value={d.text} onChangeText={(t) => set({ text: t })} multiline placeholder="One per line" placeholderTextColor={theme.textSecondary} className={`${inputClass} min-h-28 py-3`} textAlignVertical="top" />;
      case 'object':
      case 'object_list':
        return (
          <View className="gap-2">
            <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              Structured value (JSON). Uploading the contract fills this in for you.
            </Text>
            <TextInput accessibilityLabel={def.label} value={d.json} onChangeText={(t) => set({ json: t })} multiline autoCapitalize="none" autoCorrect={false} className={`${inputClass} min-h-40 py-3 text-sm`} textAlignVertical="top" />
          </View>
        );
      default:
        return <TextInput accessibilityLabel={def.label} value={d.v ?? ''} onChangeText={(t) => set({ v: t })} maxLength={500} placeholder={def.hint} placeholderTextColor={theme.textSecondary} className={inputClass} />;
    }
  })();

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="px-6 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <BackLink label="‹ Cancel" />
        <Title subtitle={def.hint}>{def.label}</Title>

        {proposalId && (
          <View className={`${cardClass} mb-3 gap-1 p-4`}>
            <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">Extracted from the document</Text>
            {!proposal ? (
              <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Loading…</Text>
            ) : proposal.value === null ? (
              <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">{NOT_FOUND_LABEL[proposal.not_found_reason ?? 'not_found']}</Text>
            ) : (
              <>
                <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">{formatFieldValue(def, proposal.value)}</Text>
                {proposal.source_excerpt && (
                  <Text className="font-manrope text-sm italic text-text-secondary dark:text-text-secondary-dark">
                    “{proposal.source_excerpt}”{proposal.page_no ? ` (page ${proposal.page_no})` : ''}
                  </Text>
                )}
                {proposal.page_no && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.push({ pathname: '/project/[id]/contract/source', params: { id, documentId: proposal.document_id, page: String(proposal.page_no), excerpt: proposal.source_excerpt ?? '' } })}
                    className="min-h-11 justify-center self-start active:opacity-70">
                    <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">View source ›</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
        )}

        {current && (
          <View className={`${cardClass} mb-5 gap-1 p-4`}>
            <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">Currently confirmed</Text>
            <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">
              {current.not_stated ? 'Not stated in the contract' : formatFieldValue(def, current.value)}
            </Text>
            {current.source_excerpt && (
              <Text className="font-manrope text-sm italic text-text-secondary dark:text-text-secondary-dark">
                “{current.source_excerpt}”{current.source_page ? ` (page ${current.source_page})` : ''}
              </Text>
            )}
          </View>
        )}

        <Label text="Value" />
        {editor}
        {!check.ok && draft && <Text className="mt-2 font-manrope text-xs text-red-700 dark:text-red-400">{check.error}</Text>}

        <ErrorText message={error} />
        <View className="mt-6 gap-3">
          <PrimaryButton label="Confirm value" onPress={() => save(false)} disabled={!c.canConfirm || !check.ok || (!!proposalId && !proposal)} busy={saving} />
          {def.key !== 'contract_form' && (
            <Pressable accessibilityRole="button" disabled={!c.canConfirm || saving} onPress={() => save(true)} className="min-h-11 items-center justify-center active:opacity-70">
              <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">The contract doesn’t state this</Text>
            </Pressable>
          )}
        </View>
        {def.key === 'contract_form' && (
          <Text className="mt-3 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
            Confirming the form loads its standard deadline rules for you to check. Changing it later replaces them.
          </Text>
        )}
        <Disclaimer />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

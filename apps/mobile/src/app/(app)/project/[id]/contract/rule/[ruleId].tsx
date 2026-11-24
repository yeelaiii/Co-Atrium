import { EVENT_TYPE_INFO, EVENT_TYPES, type EventType } from '@shared/contracts/eventTypes.ts';
import { PERIOD_UNITS, type PeriodUnit, unitLabel } from '@shared/deadlines/calculator.ts';
import { canVerify, type Party } from '@shared/deadlines/rules.ts';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackLink, cardClass, Disclaimer, ErrorText, inputClass, Label, PrimaryButton, SecondaryButton, StatusPill, Title } from '@/components/deadlines/ui';
import { OptionSheet } from '@/components/OptionSheet';
import { useContract } from '@/hooks/use-contract';
import { fieldLabel } from '@/lib/contract-fields';
import { deadlineErrorMessage, eventLabel, ORIGIN_LABEL, PARTIES, PARTY_LABEL, rulePeriodText, TODO_LABEL } from '@/lib/deadlines';
import { useTheme } from '@/theme/use-theme';

type Tri = boolean | null;

function YesNo({ label, value, onChange, todo }: { label: string; value: Tri; onChange: (v: boolean) => void; todo?: boolean }) {
  return (
    <View className="mt-5">
      <Label text={`${label}${todo ? ' (TODO_VERIFY)' : ''}`} />
      <View className="flex-row gap-2">
        {[true, false].map((v) => {
          const active = value === v;
          return (
            <Pressable
              key={String(v)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(v)}
              className={`min-h-12 flex-1 items-center justify-center rounded-button border active:opacity-70 ${active ? 'border-accent dark:border-accent-dark' : 'border-border dark:border-border-dark'}`}>
              <Text className={`text-base text-text-primary dark:text-text-primary-dark ${active ? 'font-manrope-bold' : 'font-manrope'}`}>{v ? 'Yes' : 'No'}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function UnitPicker({ value, onChange }: { value: PeriodUnit | null; onChange: (u: PeriodUnit) => void }) {
  return (
    <View className="mt-2 flex-row flex-wrap gap-2">
      {PERIOD_UNITS.map((u) => {
        const active = u === value;
        return (
          <Pressable
            key={u}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(u)}
            className={`min-h-11 justify-center rounded-button border px-3 active:opacity-70 ${active ? 'border-accent dark:border-accent-dark' : 'border-border dark:border-border-dark'}`}>
            <Text className={`text-sm text-text-primary dark:text-text-primary-dark ${active ? 'font-manrope-bold' : 'font-manrope'}`}>{unitLabel(u, 2)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type Sheet = 'trigger' | 'closed' | 'responsible' | 'recipient' | null;

/** View, fill in, verify or reject one rule; or ('new') add a project procedure rule. */
export default function RuleScreen() {
  const { id, ruleId } = useLocalSearchParams<{ id: string; ruleId: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const c = useContract(id);
  const isNew = ruleId === 'new';
  const rule = isNew ? null : c.rules.find((r) => r.id === ruleId) ?? null;

  // Edits: undefined = untouched (keeps TODO_VERIFY), a value = entered by the user.
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const [useField, setUseField] = useState<boolean | undefined>(undefined);
  const [unit, setUnit] = useState<PeriodUnit | undefined>(undefined);
  const [ph, setPh] = useState<boolean | undefined>(undefined);
  const [timeBar, setTimeBar] = useState<boolean | undefined>(undefined);
  const [clause, setClause] = useState<string | undefined>(undefined);
  // New rule only
  const [obligation, setObligation] = useState('');
  const [label, setLabel] = useState('');
  const [trigger, setTrigger] = useState<EventType | null>(null);
  const [closedBy, setClosedBy] = useState<EventType | null>(null);
  const [responsible, setResponsible] = useState<Party | null>(null);
  const [recipient, setRecipient] = useState<Party | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const todo = new Set(rule?.todo_verify ?? []);
  const periodNum = period === undefined ? undefined : period.trim() === '' ? null : Number(period);
  const periodOk = periodNum === undefined || periodNum === null || (Number.isInteger(periodNum) && periodNum >= 0 && periodNum <= 3650);

  const patch: Record<string, unknown> = {};
  if (useField === true) patch.period = null;
  else if (periodNum !== undefined) patch.period = periodNum;
  if (unit !== undefined) patch.unit = unit;
  if (ph !== undefined) patch.includes_public_holidays = ph;
  if (timeBar !== undefined) patch.is_time_bar = timeBar;
  if (clause !== undefined) patch.source_clause = clause.trim();
  const dirty = Object.keys(patch).length > 0;

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) return setError(deadlineErrorMessage(err));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    after?.();
  };

  const reset = () => {
    setPeriod(undefined);
    setUseField(undefined);
    setUnit(undefined);
    setPh(undefined);
    setTimeBar(undefined);
    setClause(undefined);
  };

  const eventLabels = EVENT_TYPES.map((t) => EVENT_TYPE_INFO[t].label);
  const partyLabels = PARTIES.map((p) => PARTY_LABEL[p]);
  const sheetProps =
    sheet === 'trigger' || sheet === 'closed'
      ? { title: sheet === 'trigger' ? 'Starts when' : 'Met when this is logged', options: eventLabels, selected: (sheet === 'trigger' ? trigger : closedBy) ? EVENT_TYPE_INFO[(sheet === 'trigger' ? trigger : closedBy)!].label : null }
      : { title: sheet === 'responsible' ? 'Who must act' : 'Waiting party', options: partyLabels, selected: (sheet === 'responsible' ? responsible : recipient) ? PARTY_LABEL[(sheet === 'responsible' ? responsible : recipient)!] : null };
  const onPick = (o: string) => {
    const k = sheet;
    setSheet(null);
    if (k === 'trigger' || k === 'closed') {
      const t = EVENT_TYPES.find((x) => EVENT_TYPE_INFO[x].label === o) ?? null;
      if (k === 'trigger') setTrigger(t);
      else setClosedBy(t);
    } else {
      const p = PARTIES.find((x) => PARTY_LABEL[x] === o) ?? null;
      if (k === 'responsible') setResponsible(p);
      else setRecipient(p);
    }
  };

  const picker = (text: string, value: string | null, k: Exclude<Sheet, null>) => (
    <Pressable accessibilityRole="button" accessibilityLabel={`${text}: ${value ?? 'not set'}. Change`} onPress={() => setSheet(k)} className="min-h-[52px] justify-center rounded-button border border-border bg-surface px-4 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      <Text className={`font-manrope text-base ${value ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>{value ?? 'Choose'}</Text>
    </Pressable>
  );

  const timing = (
    <>
      <Label text={`Period${todo.has('period') ? ' (TODO_VERIFY)' : ''}`} className="mt-5" />
      {rule?.period_field && (
        <YesNo
          label={`Take it from the contract (${fieldLabel(rule.period_field)})`}
          value={useField ?? (rule.period === null && !todo.has('period') ? true : null)}
          onChange={setUseField}
        />
      )}
      {useField !== true && (
        <TextInput
          accessibilityLabel="Period"
          value={period ?? rule?.period?.toString() ?? ''}
          onChangeText={setPeriod}
          keyboardType="number-pad"
          maxLength={4}
          placeholder="e.g. 14"
          placeholderTextColor={theme.textSecondary}
          className={`${inputClass} mt-2`}
        />
      )}
      <Label text={`Unit${todo.has('unit') ? ' (TODO_VERIFY)' : ''}`} className="mt-5" />
      <UnitPicker value={unit ?? rule?.unit ?? null} onChange={setUnit} />
      <YesNo label="Public holidays count" value={ph ?? rule?.includes_public_holidays ?? null} onChange={setPh} todo={todo.has('includes_public_holidays')} />
      <YesNo label="Time bar (late = entitlement may be lost)" value={timeBar ?? rule?.is_time_bar ?? null} onChange={setTimeBar} todo={todo.has('is_time_bar')} />
    </>
  );

  if (isNew) {
    const p = periodNum ?? null;
    const valid = obligation.trim().length >= 3 && label.trim().length >= 2 && !!trigger && !!responsible && !!recipient && p !== null && periodOk && !!unit;
    const create = () =>
      run(
        () =>
          c.createRule({
            origin: 'project_procedure',
            obligation: obligation.trim(),
            reminder_label: label.trim(),
            trigger_event_type: trigger,
            responsible_role: responsible,
            recipient_role: recipient,
            period: p,
            unit,
            includes_public_holidays: ph ?? null,
            is_time_bar: timeBar ?? false,
            closed_by_event_types: closedBy ? [closedBy] : [],
            source_clause: clause?.trim() || null,
          }),
        () => router.back(),
      );
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
        <ScrollView contentContainerClassName="px-6 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <BackLink label="‹ Cancel" />
          <Title subtitle="For periods set by the preliminaries or project procedures, e.g. RFI replies within 7 working days. It starts as a draft: verify it to create deadlines.">
            Add project rule
          </Title>
          <Label text="What must be done" />
          <TextInput accessibilityLabel="What must be done" value={obligation} onChangeText={setObligation} placeholder="Reply to the RFI" placeholderTextColor={theme.textSecondary} maxLength={300} className={inputClass} />
          <Label text="Short name for reminders" className="mt-5" />
          <TextInput accessibilityLabel="Short name for reminders" value={label} onChangeText={setLabel} placeholder="reply" placeholderTextColor={theme.textSecondary} maxLength={60} className={inputClass} />
          <Label text="Starts when" className="mt-5" />
          {picker('Starts when', trigger ? EVENT_TYPE_INFO[trigger].label : null, 'trigger')}
          <Label text="Met when this is logged" optional className="mt-5" />
          {picker('Met when', closedBy ? EVENT_TYPE_INFO[closedBy].label : null, 'closed')}
          <View className="mt-5 flex-row gap-3">
            <View className="flex-1"><Label text="Who must act" />{picker('Who must act', responsible ? PARTY_LABEL[responsible] : null, 'responsible')}</View>
            <View className="flex-1"><Label text="Waiting party" />{picker('Waiting party', recipient ? PARTY_LABEL[recipient] : null, 'recipient')}</View>
          </View>
          {timing}
          <Label text="Where it says so" optional className="mt-5" />
          <TextInput accessibilityLabel="Where it says so" value={clause ?? ''} onChangeText={setClause} placeholder="e.g. Preliminaries item 12" placeholderTextColor={theme.textSecondary} maxLength={60} className={inputClass} />
          <ErrorText message={error} />
          <View className="mt-6"><PrimaryButton label="Add rule" onPress={create} disabled={!valid} busy={busy} /></View>
          <Disclaimer />
        </ScrollView>
        <OptionSheet visible={!!sheet} title={sheetProps.title} options={sheetProps.options} selected={sheetProps.selected} onSelect={onPick} onClose={() => setSheet(null)} />
      </KeyboardAvoidingView>
    );
  }

  if (!rule) {
    return (
      <View className="flex-1 bg-background px-6 dark:bg-background-dark" style={{ paddingTop: insets.top + 16 }}>
        <BackLink />
        <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{c.loading ? 'Loading…' : 'Rule not found.'}</Text>
      </View>
    );
  }

  const verifiable = !dirty && rule.status !== 'verified' && canVerify({
    todoVerify: rule.todo_verify,
    period: rule.period,
    unit: rule.unit,
    periodField: rule.period_field,
    defaultPeriod: rule.default_period,
  }) && rule.is_time_bar !== null;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="px-6 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <BackLink />
        <Title subtitle={`${ORIGIN_LABEL[rule.origin]} · ${rule.rule_key}`}>{rule.obligation}</Title>
        <View className="mb-2 flex-row flex-wrap gap-2">
          {rule.status === 'verified' ? <StatusPill status="met" label="Verified" /> : rule.status === 'rejected' ? <StatusPill status="waived" label="Rejected" /> : <StatusPill status="open" label="Draft" />}
          {rule.is_time_bar && <StatusPill status="time_bar" />}
        </View>

        <View className={`${cardClass} gap-2 p-4`}>
          <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">
            {PARTY_LABEL[rule.responsible_role]} → {PARTY_LABEL[rule.recipient_role]}
          </Text>
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {rulePeriodText(rule, fieldLabel)} after{' '}
            {rule.trigger_event_type === 'completion_date' ? 'the completion date' : rule.trigger_event_type === 'chained' ? 'the earlier deadline' : eventLabel(rule.trigger_event_type).toLowerCase()}
          </Text>
          {rule.closed_by_event_types.length > 0 && (
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              Met when logged: {rule.closed_by_event_types.map((t) => eventLabel(t)).join(' or ')}
            </Text>
          )}
          {rule.consequence && <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">If missed: {rule.consequence}</Text>}
          {rule.todo_verify.length > 0 && (
            <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
              Check against your contract: {rule.todo_verify.map((t) => TODO_LABEL[t] ?? t).join(', ')}
            </Text>
          )}
        </View>

        {c.canConfirm && rule.origin !== 'statute' && (
          <>
            {timing}
            <Label text={`Clause${todo.has('clause_ref') ? ' (TODO_VERIFY)' : ''}`} className="mt-5" />
            <TextInput accessibilityLabel="Clause" value={clause ?? rule.source_clause ?? ''} onChangeText={setClause} placeholder="e.g. 23.1" placeholderTextColor={theme.textSecondary} maxLength={60} className={inputClass} />
            {rule.status === 'verified' && dirty && (
              <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">Saving changes puts the rule back to draft until it is verified again.</Text>
            )}
            <View className="mt-5">
              <SecondaryButton label="Save changes" disabled={!dirty || !periodOk || busy} onPress={() => run(() => c.updateRule(rule.id, patch), reset)} />
            </View>
          </>
        )}

        <ErrorText message={error} />
        {c.canConfirm && (
          <View className="mt-6 gap-3">
            {rule.status !== 'verified' && (
              <PrimaryButton label="Verify rule" disabled={!verifiable} busy={busy} onPress={() => run(() => c.verifyRule(rule.id))} />
            )}
            {!verifiable && rule.status === 'draft' && (
              <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
                {dirty ? 'Save your changes first.' : 'Fill in every TODO_VERIFY value before verifying.'}
              </Text>
            )}
            {rule.status !== 'rejected' && (
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(() => c.rejectRule(rule.id))} className="min-h-11 items-center justify-center active:opacity-70">
                <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">Doesn’t apply to this contract</Text>
              </Pressable>
            )}
          </View>
        )}
        <Disclaimer />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

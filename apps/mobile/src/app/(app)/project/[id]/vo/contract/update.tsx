import { EVENT_TYPE_INFO, type EventType } from '@shared/contracts/eventTypes.ts';
import { VO_SOURCES, VO_STATUS_LABEL, type VoContractStatus, type VoSource } from '@shared/contracts/variations.ts';
import { computeServedAt, formatShortDate, toSgt } from '@shared/deadlines/index.ts';
import type { Party } from '@shared/deadlines/rules.ts';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DateTimeField } from '@/components/deadlines/DateTimeField';
import { BackLink, ErrorText, inputClass, Label, PrimaryButton, Title } from '@/components/deadlines/ui';
import { OptionSheet } from '@/components/OptionSheet';
import { useContract, useDeadlineCalendar } from '@/hooks/use-contract';
import { useVoContract } from '@/hooks/use-vo-contract';
import { deadlineErrorMessage, PARTIES, PARTY_LABEL, requestObligations, requestRecalculation } from '@/lib/deadlines';
import { invalidateQueries } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';
import { cleanLine, cleanMultiline, voCode } from '@/lib/variation-orders';
import { formatMoney, parseAmount, VO_SOURCE_LABEL, type VoAction } from '@/lib/vo-contract';
import { useTheme } from '@/theme/use-theme';

type EventAction = 'quotation' | 'valuation' | 'instruction' | 'confirmation' | 'objection';

const EVENT_FOR: Record<EventAction, { type: EventType; title: string; raised: Party; to: Party; help: string }> = {
  quotation: {
    type: 'variation_quotation_submitted', title: 'Log quotation', raised: 'contractor', to: 'contract_admin',
    help: 'The amount becomes the claimed amount; days of extra time become the time claimed.',
  },
  valuation: {
    type: 'variation_valuation_issued', title: 'Log valuation', raised: 'contract_admin', to: 'contractor',
    help: 'The amount becomes the assessed amount. An objection window may start now.',
  },
  instruction: {
    type: 'instruction_issued', title: 'Log instruction', raised: 'contract_admin', to: 'contractor',
    help: 'The written instruction (AI, SOI or ER instruction) for this variation. A quotation or notice of claim may now be due.',
  },
  confirmation: {
    type: 'oral_instruction_confirmed', title: 'Log written confirmation', raised: 'contractor', to: 'contract_admin',
    help: 'Your written confirmation of the oral instruction. This closes the confirmation deadline.',
  },
  objection: {
    type: 'variation_objection_served', title: 'Log objection', raised: 'contractor', to: 'contract_admin',
    help: 'Objection to the instruction or its valuation. The VO is marked disputed.',
  },
};

const isEventAction = (a: string): a is EventAction => a in EVENT_FOR;
const NONE = 'None';

function Field({ label, value, onChange, placeholder, numeric, optional = true }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; numeric?: boolean; optional?: boolean;
}) {
  const theme = useTheme();
  return (
    <>
      <Label text={label} optional={optional} className="mt-5" />
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        autoCapitalize={numeric ? 'none' : 'characters'}
        maxLength={numeric ? 18 : 60}
        className={inputClass}
      />
    </>
  );
}

/** One form for every contractual update of a VO; `action` picks which. */
export default function UpdateVoContract() {
  const { id, voId, action, to } = useLocalSearchParams<{ id: string; voId: string; action: VoAction; to?: VoContractStatus }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const contract = useContract(id);
  const calendar = useDeadlineCalendar(id);
  const { vo, events } = useVoContract(voId);
  const c = vo?.contract;

  const ev = isEventAction(action) ? EVENT_FOR[action] : null;
  const info = ev ? EVENT_TYPE_INFO[ev.type] : null;

  // Event fields
  const [reference, setReference] = useState(() => (ev && EVENT_TYPE_INFO[ev.type].refPrefix ? `${EVENT_TYPE_INFO[ev.type].refPrefix}-` : ''));
  const [sentAt, setSentAt] = useState(() => new Date());
  const [raisedBy, setRaisedBy] = useState<Party | null>(ev?.raised ?? null);
  const [addressedTo, setAddressedTo] = useState<Party | null>(ev?.to ?? null);
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('');
  const [notes, setNotes] = useState('');
  // Amount fields (agree / amounts); prefilled once the VO loads.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [claimed, setClaimed] = useState('');
  const [assessed, setAssessed] = useState('');
  const [agreed, setAgreed] = useState('');
  const [timeClaimed, setTimeClaimed] = useState('');
  const [timeAgreed, setTimeAgreed] = useState('');
  const [omission, setOmission] = useState(false);
  const [source, setSource] = useState<VoSource | null>(null);
  const [instructingParty, setInstructingParty] = useState<Party | null>(null);
  const [instructionRef, setInstructionRef] = useState('');

  const [sheet, setSheet] = useState<'raised' | 'addressed' | 'source' | 'instructing' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (vo && c && loadedFor !== vo.id) {
    setLoadedFor(vo.id);
    const s = (n: number | null) => (n === null ? '' : String(n));
    setClaimed(s(c.claimed));
    setAssessed(s(c.assessed));
    setAgreed(action === 'agree' ? s(c.agreed ?? c.assessed ?? c.claimed) : s(c.agreed));
    setTimeClaimed(s(c.timeClaimed));
    setTimeAgreed(action === 'agree' ? s(c.timeAgreed ?? c.timeClaimed) : s(c.timeAgreed));
    setOmission(c.isOmission);
    setSource(c.source);
    setInstructingParty(c.instructingParty);
    setInstructionRef(c.instructionReference ?? '');
  }

  const currency = useMemo(() => {
    const cur = contract.fields.get('currency')?.value;
    return typeof cur === 'string' ? cur : 'SGD';
  }, [contract.fields]);

  // The request this answers, so the response closes the right deadline (e.g. a valuation answers the quotation).
  const related = useMemo(() => {
    if (!info?.responds_to.length) return null;
    return [...events].reverse().find((e) => !e.voided_at && info.responds_to.includes(e.event_type)) ?? null;
  }, [events, info]);

  const served = calendar && info?.served ? computeServedAt(sentAt, calendar) : null;
  const dayOk = (v: string) => v.trim() === '' || /^\d{1,4}$/.test(v.trim());
  const amountOk = (v: string) => !Number.isNaN(parseAmount(v));

  const title = ev ? ev.title : action === 'agree' ? 'Mark agreed' : action === 'status' && to ? `Mark ${VO_STATUS_LABEL[to].toLowerCase()}` : 'Amounts and time';

  const valid = (() => {
    if (!vo) return false;
    if (ev) {
      return cleanLine(reference.trim(), 60) && cleanMultiline(notes.trim(), 2000) && amountOk(amount) && dayOk(days);
    }
    if (action === 'agree') return parseAmount(agreed) !== null && amountOk(agreed) && dayOk(timeAgreed) && cleanMultiline(notes.trim(), 500);
    if (action === 'status') return !!to && cleanMultiline(notes.trim(), 500);
    return [claimed, assessed, agreed].every(amountOk) && [timeClaimed, timeAgreed].every(dayOk) && cleanLine(instructionRef.trim(), 60);
  })();

  const intOrNull = (v: string) => (v.trim() === '' ? null : Number(v.trim()));

  const save = async () => {
    if (!valid || saving || !vo || !c) return;
    setSaving(true);
    setError(null);
    try {
      if (ev) {
        const ref = reference.trim().replace(/-$/, '');
        const { error: e } = await supabase.rpc('log_variation_event', {
          vid: vo.id,
          ev_type: ev.type,
          ev_sent_at: sentAt.toISOString(),
          ev_served_at: served ? served.servedAt.toISOString() : sentAt.toISOString(),
          ev_reference: ref || null,
          ev_raised_by: raisedBy,
          ev_addressed_to: addressedTo,
          ev_related_event: related?.id ?? null,
          amount: action === 'quotation' || action === 'valuation' ? parseAmount(amount) : null,
          time_days: action === 'quotation' ? intOrNull(days) : null,
          ev_attachments: [],
          ev_notes: notes.trim() || null,
        });
        if (e) throw e;
        await requestObligations(id);
      } else {
        let patch: Record<string, unknown> = {};
        if (action === 'agree') {
          patch = { contract_status: 'agreed', agreed_amount: parseAmount(agreed), time_impact_days_agreed: intOrNull(timeAgreed) };
        } else if (action === 'status' && to) {
          patch = { contract_status: to };
        } else {
          // Only what changed, so the history shows real changes and agreed values stay with contract roles.
          const add = (k: string, now: unknown, was: unknown) => {
            if (now !== was) patch[k] = now;
          };
          add('claimed_amount', parseAmount(claimed), c.claimed);
          add('assessed_amount', parseAmount(assessed), c.assessed);
          add('time_impact_days_claimed', intOrNull(timeClaimed), c.timeClaimed);
          add('is_omission', omission, c.isOmission);
          add('source', source, c.source);
          add('instructing_party', instructingParty, c.instructingParty);
          add('instruction_reference', instructionRef.trim() || null, c.instructionReference);
          if (contract.canConfirm) {
            add('agreed_amount', parseAmount(agreed), c.agreed);
            add('time_impact_days_agreed', intOrNull(timeAgreed), c.timeAgreed);
          }
          if (Object.keys(patch).length === 0) {
            router.back();
            return;
          }
        }
        const { error: e } = await supabase.rpc('update_variation_contract', { vid: vo.id, patch, source_event: null, note: notes.trim() || null });
        if (e) throw e;
        if ('time_impact_days_claimed' in patch || 'time_impact_days_agreed' in patch || action === 'agree' || to === 'withdrawn') {
          requestRecalculation(id);
        }
      }
      invalidateQueries(`vo:${vo.id}`, `project:${id}:obligations`, `project:${id}:claim-refs`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (e) {
      setError(deadlineErrorMessage(e));
      setSaving(false);
    }
  };

  const partyLabels = [...PARTIES.map((p) => PARTY_LABEL[p]), NONE];
  const sheetProps =
    sheet === 'source'
      ? { title: 'Source', options: [...VO_SOURCES.map((s) => VO_SOURCE_LABEL[s]), NONE], selected: source ? VO_SOURCE_LABEL[source] : NONE }
      : {
          title: sheet === 'raised' ? 'Raised by' : sheet === 'addressed' ? 'Addressed to' : 'Instructed by',
          options: partyLabels,
          selected: (() => {
            const p = sheet === 'raised' ? raisedBy : sheet === 'addressed' ? addressedTo : instructingParty;
            return p ? PARTY_LABEL[p] : NONE;
          })(),
        };
  const onPick = (option: string) => {
    const kind = sheet;
    setSheet(null);
    if (kind === 'source') return setSource(VO_SOURCES.find((s) => VO_SOURCE_LABEL[s] === option) ?? null);
    const p = PARTIES.find((x) => PARTY_LABEL[x] === option) ?? null;
    if (kind === 'raised') setRaisedBy(p);
    else if (kind === 'addressed') setAddressedTo(p);
    else setInstructingParty(p);
  };
  const picker = (label: string, value: string | null, kind: NonNullable<typeof sheet>) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? 'Not set'}. Change`}
      onPress={() => setSheet(kind)}
      className="min-h-[52px] justify-center rounded-button border border-border bg-surface px-4 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      <Text className={`font-manrope text-base ${value ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
        {value ?? 'Not set'}
      </Text>
    </Pressable>
  );

  const notesField = (label: string, max: number) => (
    <>
      <Label text={label} optional className="mt-5" />
      <TextInput
        accessibilityLabel={label}
        value={notes}
        onChangeText={setNotes}
        multiline
        maxLength={max}
        placeholderTextColor={theme.textSecondary}
        className={`${inputClass} min-h-20 py-3`}
        textAlignVertical="top"
      />
    </>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="px-6 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <BackLink label="‹ Cancel" />
        <Title subtitle={vo ? `${voCode(vo)} · ${vo.name}` : undefined}>{title}</Title>

        {ev && (
          <>
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{ev.help}</Text>
            {related && (
              <Text className="mt-2 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                Answers {related.reference ?? EVENT_TYPE_INFO[related.event_type].label} of {formatShortDate(toSgt(new Date(related.sent_at)).date, true)}.
              </Text>
            )}
            <Field label="Reference" value={reference} onChange={setReference} placeholder="e.g. AI-045" />
            <Label text={info?.served === false ? 'When' : 'Sent'} className="mt-5" />
            <DateTimeField accessibilityLabel="Sent" value={sentAt} onChange={setSentAt} maximumDate={new Date()} />
            {served && (
              <Text className="mt-2 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                Served {formatShortDate(served.servedDate, true)}
              </Text>
            )}
            {(action === 'quotation' || action === 'valuation') && (
              <Field label={`Amount (${currency})`} value={amount} onChange={setAmount} placeholder="e.g. 12,000" numeric />
            )}
            {action === 'quotation' && <Field label="Extra time claimed (days)" value={days} onChange={setDays} numeric />}
            <View className="mt-5 flex-row gap-3">
              <View className="flex-1">
                <Label text="Raised by" optional />
                {picker('Raised by', raisedBy ? PARTY_LABEL[raisedBy] : null, 'raised')}
              </View>
              <View className="flex-1">
                <Label text="Addressed to" optional />
                {picker('Addressed to', addressedTo ? PARTY_LABEL[addressedTo] : null, 'addressed')}
              </View>
            </View>
            {notesField('Notes', 2000)}
            <Text className="mt-3 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              To attach files, use “Log another event or attach a file” on the VO. This records the event in Co-Atrium only; it sends nothing to the other party.
            </Text>
          </>
        )}

        {action === 'agree' && (
          <>
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              The agreed amount goes into the revised contract sum{c?.isOmission ? ' as an omission (deducted)' : ''}. Agreed time moves the completion date and the deadlines that depend on it. Agreed is final.
            </Text>
            <Field label={`Agreed amount (${currency})`} value={agreed} onChange={setAgreed} numeric optional={false} placeholder="0 for a time-only variation" />
            {c && (
              <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
                Claimed {formatMoney(c.claimed, currency)} · assessed {formatMoney(c.assessed, currency)}
              </Text>
            )}
            <Field label="Extra time agreed (days)" value={timeAgreed} onChange={setTimeAgreed} numeric />
            {notesField('Note', 500)}
          </>
        )}

        {action === 'status' && to && (
          <>
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              {to === 'withdrawn'
                ? 'Withdrawn is final. Open deadlines for this VO are waived (kept on record, marked withdrawn).'
                : to === 'rejected'
                  ? 'Rejected is final. Deadlines stay open: an objection or claim period may still be running.'
                  : 'Marks the VO as disputed. Log the objection itself as an event if one was served.'}
            </Text>
            {notesField('Why', 500)}
          </>
        )}

        {action === 'amounts' && c && (
          <>
            <Field label={`Claimed (${currency})`} value={claimed} onChange={setClaimed} numeric />
            <Field label={`Assessed (${currency})`} value={assessed} onChange={setAssessed} numeric />
            {contract.canConfirm && c.status === 'agreed' && (
              <Field label={`Agreed (${currency})`} value={agreed} onChange={setAgreed} numeric />
            )}
            <View className="mt-5 min-h-12 flex-row items-center justify-between gap-3">
              <View className="flex-1">
                <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Omission</Text>
                <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">Work taken out: the amounts reduce the contract sum.</Text>
              </View>
              <Switch
                accessibilityLabel="Omission"
                value={omission}
                onValueChange={setOmission}
                disabled={c.status === 'agreed' && !contract.canConfirm}
                trackColor={{ true: theme.accent }}
              />
            </View>
            <Field label="Extra time claimed (days)" value={timeClaimed} onChange={setTimeClaimed} numeric />
            {contract.canConfirm && c.status === 'agreed' && <Field label="Extra time agreed (days)" value={timeAgreed} onChange={setTimeAgreed} numeric />}
            <Label text="Source" optional className="mt-5" />
            {picker('Source', source ? VO_SOURCE_LABEL[source] : null, 'source')}
            <Label text="Instructed by" optional className="mt-5" />
            {picker('Instructed by', instructingParty ? PARTY_LABEL[instructingParty] : null, 'instructing')}
            <Field label="Instruction reference" value={instructionRef} onChange={setInstructionRef} placeholder="e.g. AI-045, SOI-12" />
            {notesField('Note for the history', 500)}
          </>
        )}

        <ErrorText message={error} />
        <View className="mt-6">
          <PrimaryButton label={ev ? 'Save event' : 'Save'} onPress={save} disabled={!valid} busy={saving} />
        </View>
      </ScrollView>
      <OptionSheet visible={!!sheet} title={sheetProps.title} options={sheetProps.options} selected={sheetProps.selected} onSelect={onPick} onClose={() => setSheet(null)} />
    </KeyboardAvoidingView>
  );
}

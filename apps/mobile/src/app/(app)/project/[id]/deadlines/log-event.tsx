import { EVENT_TYPE_INFO, EVENT_TYPES, type EventType } from '@shared/contracts/eventTypes.ts';
import { computeServedAt, formatShortDate, toSgt } from '@shared/deadlines/index.ts';
import type { Party } from '@shared/deadlines/rules.ts';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DateTimeField } from '@/components/deadlines/DateTimeField';
import { BackLink, ErrorText, inputClass, Label, PrimaryButton, SecondaryButton, Title } from '@/components/deadlines/ui';
import { OptionSheet } from '@/components/OptionSheet';
import { usePhotoSource } from '@/components/vo/capture';
import { useContract, useDeadlineCalendar } from '@/hooks/use-contract';
import { useObligations } from '@/hooks/use-obligations';
import { usePaymentClaimRefs } from '@/hooks/use-payment-claim-refs';
import { useVariationOrders } from '@/hooks/use-variation-orders';
import {
  deadlineErrorMessage,
  eventLabel,
  type LocalFile,
  PARTIES,
  PARTY_LABEL,
  requestObligations,
  uploadEventFiles,
} from '@/lib/deadlines';
import { supabase } from '@/lib/supabase';
import { cleanLine, cleanMultiline, voCode } from '@/lib/variation-orders';
import { formatMoney } from '@/lib/vo-contract';
import { useTheme } from '@/theme/use-theme';

const MAX_FILES = 20;
const NONE = 'None';

type SheetKind = 'type' | 'raised' | 'addressed' | 'related' | null;

/** Log event: type, reference, when, who, optional link to the request it answers, files. */
export default function LogEvent() {
  const { id, type: initialType, related: initialRelated, vo } = useLocalSearchParams<{
    id: string;
    type?: string;
    related?: string;
    vo?: string;
  }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const contract = useContract(id);
  const { events } = useObligations(id);
  const calendar = useDeadlineCalendar(id);

  const [type, setType] = useState<EventType | null>(
    initialType && (EVENT_TYPES as readonly string[]).includes(initialType) ? (initialType as EventType) : null,
  );
  const [reference, setReference] = useState('');
  const [sentAt, setSentAt] = useState(() => new Date());
  const [raisedBy, setRaisedBy] = useState<Party | null>(null);
  const [addressedTo, setAddressedTo] = useState<Party | null>(null);
  const [relatedId, setRelatedId] = useState<string | null>(initialRelated ?? null);
  const [extensionDays, setExtensionDays] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [sheet, setSheet] = useState<SheetKind>(null);
  // Payment claims: agreed VOs included in this claim. null = not touched yet (all agreed VOs).
  const [claimVos, setClaimVos] = useState<Set<string> | null>(null);
  const { variationOrders } = useVariationOrders(id);
  const claimRefs = usePaymentClaimRefs(id);
  const agreedVos = useMemo(
    () => variationOrders.filter((v) => v.contract.status === 'agreed').sort((a, b) => a.number - b.number),
    [variationOrders],
  );
  const included = claimVos ?? new Set(agreedVos.map((v) => v.id));
  const toggleVo = (vid: string) =>
    setClaimVos(() => {
      const next = new Set(included);
      if (next.has(vid)) next.delete(vid);
      else next.add(vid);
      return next;
    });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const raised = raisedBy ?? contract.myParty;
  const info = type ? EVENT_TYPE_INFO[type] : null;
  const remaining = MAX_FILES - files.length;
  const { openPhotoSource, photoSheet } = usePhotoSource(
    (photos) => setFiles((f) => [...f, ...photos.map((p, i) => ({ uri: p.uri, mimeType: p.mimeType, name: `photo-${f.length + i + 1}.jpg` }))]),
    remaining,
  );

  // Requests this event can answer: e.g. an RFI response links to its RFI, so the reply closes the right deadline.
  const candidates = useMemo(
    () => (info?.responds_to.length ? events.filter((e) => info.responds_to.includes(e.event_type)) : []),
    [events, info],
  );
  const related = events.find((e) => e.id === relatedId) ?? null;
  const eventName = (e: (typeof events)[number]) => `${e.reference ?? eventLabel(e.event_type)} · ${formatShortDate(toSgt(new Date(e.sent_at)).date, true)}`;

  const served = calendar && info?.served ? computeServedAt(sentAt, calendar) : null;
  const servedLater = served && served.servedDate !== toSgt(sentAt).date;

  const ref = reference.trim();
  const ext = extensionDays.trim();
  const extOk = type !== 'eot_decision_issued' || ext === '' || /^\d{1,4}$/.test(ext);
  const valid = !!type && cleanLine(ref, 60) && cleanMultiline(notes.trim(), 2000) && extOk; // future dates are rejected by log_project_event

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
    if (res.canceled) return;
    const tooBig = res.assets.find((a) => (a.size ?? 0) > 25 * 1024 * 1024);
    if (tooBig) setError(`${tooBig.name} is over 25 MB.`);
    setFiles((f) => [
      ...f,
      ...res.assets
        .filter((a) => (a.size ?? 0) <= 25 * 1024 * 1024)
        .slice(0, remaining)
        .map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? 'application/octet-stream' })),
    ]);
  };

  const save = async () => {
    if (!valid || saving || !type) return;
    setSaving(true);
    setError(null);
    try {
      const paths = await uploadEventFiles(id, files);
      const { data: eventId, error: rpcError } = await supabase.rpc('log_project_event', {
        pid: id,
        ev_type: type,
        ev_sent_at: sentAt.toISOString(),
        ev_served_at: served ? served.servedAt.toISOString() : sentAt.toISOString(),
        ev_reference: ref || null,
        ev_raised_by: raised,
        ev_addressed_to: addressedTo,
        ev_related_event: relatedId,
        ev_variation_order: vo ?? null,
        ev_time_extension_days: type === 'eot_decision_issued' && ext ? Number(ext) : null,
        ev_attachments: paths,
        ev_notes: notes.trim() || null,
      });
      if (rpcError) throw rpcError;
      if (type === 'payment_claim_served' && included.size > 0) {
        const link = await supabase.rpc('set_payment_claim_variations', { eid: eventId as string, vids: [...included] });
        if (link.error) throw link.error;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await requestObligations(id);
      router.back();
    } catch (e) {
      setError(deadlineErrorMessage(e));
      setSaving(false);
    }
  };

  const typeLabels = EVENT_TYPES.map((t) => EVENT_TYPE_INFO[t].label);
  const partyLabels = [...PARTIES.map((p) => PARTY_LABEL[p]), NONE];
  const sheetProps =
    sheet === 'type'
      ? { title: 'What happened?', options: typeLabels, selected: info?.label ?? null }
      : sheet === 'related'
        ? { title: 'Responds to', options: [...candidates.map(eventName), NONE], selected: related ? eventName(related) : NONE }
        : { title: sheet === 'raised' ? 'Raised by' : 'Addressed to', options: partyLabels, selected: (sheet === 'raised' ? raised : addressedTo) ? PARTY_LABEL[(sheet === 'raised' ? raised : addressedTo)!] : NONE };

  const onPick = (option: string) => {
    const kind = sheet;
    setSheet(null);
    if (kind === 'type') {
      const t = EVENT_TYPES.find((x) => EVENT_TYPE_INFO[x].label === option) ?? null;
      setType(t);
      setRelatedId(null);
      if (t && !reference && EVENT_TYPE_INFO[t].refPrefix) setReference(`${EVENT_TYPE_INFO[t].refPrefix}-`);
    } else if (kind === 'related') {
      const e = candidates.find((c) => eventName(c) === option) ?? null;
      setRelatedId(e?.id ?? null);
      if (e?.reference && (!reference || reference.endsWith('-'))) setReference(e.reference);
    } else {
      const p = PARTIES.find((x) => PARTY_LABEL[x] === option) ?? null;
      if (kind === 'raised') setRaisedBy(p);
      else setAddressedTo(p);
    }
  };

  const picker = (label: string, value: string | null, kind: Exclude<SheetKind, null>, placeholder: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? placeholder}. Change`}
      onPress={() => setSheet(kind)}
      className="min-h-[52px] justify-center rounded-button border border-border bg-surface px-4 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      <Text className={`font-manrope text-base ${value ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
        {value ?? placeholder}
      </Text>
    </Pressable>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="px-6 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <BackLink label="‹ Cancel" />
        <Title subtitle="Deadlines run from when a document is served. Sent on a working day before the cut-off counts as served that day; otherwise the next working day.">
          Log event
        </Title>

        <Label text="Type" />
        {picker('Type', info?.label ?? null, 'type', 'Choose what happened')}

        <Label text="Reference" optional className="mt-5" />
        <TextInput
          accessibilityLabel="Reference"
          value={reference}
          onChangeText={setReference}
          placeholder="e.g. RFI-023"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="characters"
          maxLength={60}
          className={inputClass}
        />

        <Label text={info?.served === false ? 'When' : 'Sent'} className="mt-5" />
        <DateTimeField accessibilityLabel="Sent" value={sentAt} onChange={setSentAt} maximumDate={new Date()} />
        {served && (
          <Text className="mt-2 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            Served {formatShortDate(served.servedDate, true)}
            {servedLater ? ' (after the cut-off or on a non-working day)' : ''}
          </Text>
        )}

        {candidates.length > 0 && (
          <>
            <Label text="Responds to" optional className="mt-5" />
            {picker('Responds to', related ? eventName(related) : null, 'related', 'Link the request this answers')}
            <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              Linking (or using the same reference) closes the deadline for that request.
            </Text>
          </>
        )}

        {type === 'eot_decision_issued' && (
          <>
            <Label text="Extension granted (days)" optional className="mt-5" />
            <TextInput
              accessibilityLabel="Extension granted in days"
              value={extensionDays}
              onChangeText={setExtensionDays}
              keyboardType="number-pad"
              maxLength={4}
              className={inputClass}
            />
            <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              Moves the completion date and the deadlines that depend on it.
            </Text>
          </>
        )}

        {type === 'payment_claim_served' && agreedVos.length > 0 && (
          <>
            <Label text="Agreed VOs in this claim" optional className="mt-5" />
            <View className="overflow-hidden rounded-card border border-border bg-surface dark:border-border-dark dark:bg-surface-dark">
              {agreedVos.map((v, i) => {
                const on = included.has(v.id);
                const earlier = claimRefs.get(v.id) ?? [];
                return (
                  <Pressable
                    key={v.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`${voCode(v)} ${v.name}, ${formatMoney(v.contract.agreed)}${earlier.length ? `, in ${earlier.join(', ')}` : ', not yet claimed'}`}
                    onPress={() => toggleVo(v.id)}
                    className={`min-h-14 flex-row items-center gap-3 px-4 py-2 active:opacity-70 ${i === agreedVos.length - 1 ? '' : 'border-b border-border dark:border-border-dark'}`}>
                    <View className={`h-6 w-6 items-center justify-center rounded-md border-2 ${on ? 'border-accent bg-accent dark:border-accent-dark dark:bg-accent-dark' : 'border-border dark:border-border-dark'}`}>
                      {on && <Text className="font-manrope-bold text-xs text-text-on-accent dark:text-text-on-accent-dark">✓</Text>}
                    </View>
                    <View className="flex-1">
                      <Text numberOfLines={1} className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">{voCode(v)} · {v.name}</Text>
                      <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
                        {formatMoney(v.contract.isOmission ? -(v.contract.agreed ?? 0) : v.contract.agreed)} · {earlier.length ? `in ${earlier.join(', ')}` : 'not yet claimed'}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              {agreedVos.filter((v) => !included.has(v.id)).length} agreed VO(s) left out of this claim. Only VOs shared with you are listed.
            </Text>
          </>
        )}

        <View className="mt-5 flex-row gap-3">
          <View className="flex-1">
            <Label text="Raised by" optional />
            {picker('Raised by', raised ? PARTY_LABEL[raised] : null, 'raised', 'Not set')}
          </View>
          <View className="flex-1">
            <Label text="Addressed to" optional />
            {picker('Addressed to', addressedTo ? PARTY_LABEL[addressedTo] : null, 'addressed', 'Not set')}
          </View>
        </View>

        <Label text="Notes" optional className="mt-5" />
        <TextInput
          accessibilityLabel="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
          maxLength={2000}
          className={`${inputClass} min-h-24 py-3`}
          textAlignVertical="top"
        />

        <Label text="Photos, screenshots or files" optional className="mt-5" />
        {files.map((f, i) => (
          <View key={`${f.uri}-${i}`} className="mb-2 min-h-11 flex-row items-center justify-between rounded-button border border-border px-4 dark:border-border-dark">
            <Text numberOfLines={1} className="flex-1 font-manrope text-sm text-text-primary dark:text-text-primary-dark">{f.name}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${f.name}`} hitSlop={8} onPress={() => setFiles((x) => x.filter((_, j) => j !== i))} className="min-h-11 justify-center pl-3">
              <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">Remove</Text>
            </Pressable>
          </View>
        ))}
        <View className="flex-row gap-2">
          <View className="flex-1">
            <SecondaryButton icon="camera" label="Photo" onPress={openPhotoSource} disabled={remaining <= 0 || saving} />
          </View>
          <View className="flex-1">
            <SecondaryButton icon="file" label="File" onPress={pickFile} disabled={remaining <= 0 || saving} />
          </View>
        </View>

        <ErrorText message={error} />
        <View className="mt-6">
          <PrimaryButton label="Save event" onPress={save} disabled={!valid} busy={saving} />
        </View>
        <Text className="mt-3 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
          This records the event in Co-Atrium only. It does not send anything to the other party.
        </Text>
      </ScrollView>

      <OptionSheet visible={!!sheet} title={sheetProps.title} options={sheetProps.options} selected={sheetProps.selected} onSelect={onPick} onClose={() => setSheet(null)} />
      {photoSheet}
    </KeyboardAvoidingView>
  );
}

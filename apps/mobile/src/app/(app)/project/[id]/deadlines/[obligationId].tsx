import { formatDate, toSgt } from '@shared/deadlines/calendar.ts';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Share, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackLink, cardClass, Disclaimer, ErrorText, inputClass, Label, PrimaryButton, SecondaryButton, StatusPill } from '@/components/deadlines/ui';
import { useContract } from '@/hooks/use-contract';
import { useObligations } from '@/hooks/use-obligations';
import { deadlineErrorMessage, eventLabel, ORIGIN_LABEL, PARTY_LABEL, type Obligation, type ProjectEvent } from '@/lib/deadlines';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme/use-theme';

function Row({ label, value, last }: { label: string; value: string | null; last?: boolean }) {
  if (!value) return null;
  return (
    <View className={`gap-1 px-4 py-3 ${last ? '' : 'border-b border-border dark:border-border-dark'}`}>
      <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">{label}</Text>
      <Text selectable className="font-manrope text-base text-text-primary dark:text-text-primary-dark">{value}</Text>
    </View>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' }) : null);

/** Text a person can edit and send through the contract's official channel. Never sent by the app. */
function draftNotice(o: Obligation, trigger: ProjectEvent | null): string {
  return [
    'DRAFT: review, edit and send through the notice channel your contract requires. Co-Atrium has not sent this.',
    '',
    `To: ${PARTY_LABEL[o.recipient_party]}`,
    `Re: ${[o.subject, o.obligation].filter(Boolean).join(' – ')}`,
    trigger ? `Reference: ${trigger.reference ?? eventLabel(trigger.event_type)} (${eventLabel(trigger.event_type).toLowerCase()} on ${when(trigger.served_at ?? trigger.sent_at)})` : '',
    '',
    '[State the facts, the clause relied on, and what you are notifying or requesting.]',
    '',
    `Deadline tracked: ${formatDate(o.due_date)} (${o.explanation}).`,
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}

export default function ObligationDetail() {
  const { id, obligationId } = useLocalSearchParams<{ id: string; obligationId: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const data = useObligations(id);
  const contract = useContract(id);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const o = data.obligations.find((x) => x.id === obligationId) ?? null;
  const trigger = o?.trigger_event_id ? data.eventsById.get(o.trigger_event_id) ?? null : null;
  const closedBy = o?.closed_by_event_id ? data.eventsById.get(o.closed_by_event_id) ?? null : null;
  const rule = o ? contract.rules.find((r) => r.id === o.rule_id) : undefined;

  // Opening the deadline reads its reminders.
  useEffect(() => {
    if (!obligationId) return;
    supabase
      .from('notifications')
      .select('id')
      .eq('obligation_id', obligationId)
      .is('read_at', null)
      .then(({ data: rows }) => {
        if (rows?.length) supabase.rpc('mark_notifications_read', { ids: rows.map((r) => r.id) }).then(() => {});
      });
  }, [obligationId]);

  if (!o) {
    return (
      <View className="flex-1 bg-background px-6 dark:bg-background-dark" style={{ paddingTop: insets.top + 16 }}>
        <BackLink />
        {data.loading ? <ActivityIndicator color={theme.accent} className="mt-8" /> : (
          <Text className="mt-6 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">This deadline is not available.</Text>
        )}
      </View>
    );
  }

  const open = o.status === 'open' || o.status === 'overdue';
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    const err = await action();
    setBusy(false);
    if (err) setError(deadlineErrorMessage(err));
    else Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
  const responseType = rule?.closed_by_event_types[0];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="px-6 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <BackLink />
        <Text accessibilityRole="header" className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">
          {o.subject ? `${o.subject} ${o.reminder_label}` : o.obligation}
        </Text>
        <View className="mb-4 mt-2 flex-row flex-wrap gap-2">
          <StatusPill status={o.status} />
          {o.is_time_bar && <StatusPill status="time_bar" />}
        </View>

        <View className={`${cardClass} overflow-hidden`}>
          <Row label="Due" value={`${formatDate(o.due_date)}, end of day (SGT)`} />
          <Row label="How it was worked out" value={o.explanation} />
          <Row label="What" value={o.obligation} />
          <Row label="Who must act" value={PARTY_LABEL[o.responsible_party]} />
          <Row label="Waiting party" value={PARTY_LABEL[o.recipient_party]} />
          <Row label="Rule" value={rule ? `${ORIGIN_LABEL[rule.origin]}${rule.source_clause ? `, clause ${rule.source_clause}` : ''}` : o.source_label} />
          <Row label="If missed" value={rule?.consequence ?? null} />
          <Row
            label="Triggered by"
            value={trigger ? `${trigger.reference ?? eventLabel(trigger.event_type)}: ${eventLabel(trigger.event_type)}, served ${when(trigger.served_at ?? trigger.sent_at)}` : o.anchor === 'completion_date' ? 'Completion date' : o.anchor === 'variation' ? `${o.subject ?? 'VO'} time impact` : null}
          />
          <Row label="Closed by" value={closedBy ? `${closedBy.reference ?? eventLabel(closedBy.event_type)} on ${when(closedBy.sent_at)}` : null} />
          <Row label="Note" value={o.close_note} last />
        </View>
        {o.variation_order_id && (
          <View className="mt-3">
            <SecondaryButton
              icon="file"
              label={`Open ${o.subject?.startsWith('VO-') ? o.subject : 'variation order'}`}
              onPress={() => router.push({ pathname: '/project/[id]/vo/contract/[voId]', params: { id, voId: o.variation_order_id! } })}
            />
          </View>
        )}

        {o.status === 'suggested' && (
          <View className="mt-5 gap-3">
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              Suggested because {o.anchor === 'chained' ? 'an earlier deadline passed' : o.anchor === 'variation' ? `${o.subject ?? 'a VO'} records extra time` : 'of a related event'}. Confirm it if it applies; it then gets reminders.
            </Text>
            {contract.isStaff && <PrimaryButton label="Confirm it applies" busy={busy} onPress={() => run(() => data.confirmSuggested(o.id))} />}
          </View>
        )}

        {open && contract.isStaff && (
          <View className="mt-5 gap-3">
            {responseType && trigger && (
              <PrimaryButton
                label={`Log ${eventLabel(responseType).toLowerCase()}`}
                onPress={() => router.push({ pathname: '/project/[id]/deadlines/log-event', params: { id, type: responseType, related: trigger.id } })}
              />
            )}
            <SecondaryButton
              icon="file"
              label="Draft notice to review"
              onPress={() => Share.share({ message: draftNotice(o, trigger) })}
            />
          </View>
        )}

        {(open || o.status === 'suggested') && contract.isStaff && (
          <View className="mt-6">
            <Label text="Note" optional />
            <TextInput
              accessibilityLabel="Note"
              value={note}
              onChangeText={setNote}
              maxLength={500}
              placeholder={contract.canConfirm ? 'e.g. replied by email; or why it is waived' : 'e.g. replied by email'}
              placeholderTextColor={theme.textSecondary}
              className={inputClass}
            />
            <View className="mt-3 flex-row gap-2">
              {open && (
                <View className="flex-1">
                  <SecondaryButton icon="check" label="Mark as met" disabled={busy} onPress={() => run(() => data.markMet(o.id, note.trim() || undefined))} />
                </View>
              )}
              {contract.canConfirm && (
                <View className="flex-1">
                  <SecondaryButton icon="close" label="Waive" disabled={busy || !note.trim()} onPress={() => run(() => data.waive(o.id, note.trim()))} />
                </View>
              )}
            </View>
            {contract.canConfirm && !note.trim() && (
              <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">Add a note to waive.</Text>
            )}
          </View>
        )}

        <ErrorText message={error} />
        {o.due_date && toSgt(new Date()).date > o.due_date && o.status === 'overdue' && o.is_time_bar && (
          <Text className="mt-4 font-manrope-semibold text-sm text-red-700 dark:text-red-400">
            This is a time bar. A late notice may lose the entitlement. Check the contract now.
          </Text>
        )}
        <Disclaimer />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

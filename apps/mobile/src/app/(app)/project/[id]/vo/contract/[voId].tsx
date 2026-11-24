import { canTransition, VO_STATUS_LABEL, type VoContractStatus } from '@shared/contracts/variations.ts';
import { formatShortDate, toSgt } from '@shared/deadlines/index.ts';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ObligationRow } from '@/components/deadlines/ObligationRow';
import { BackLink, cardClass, Disclaimer, PrimaryButton, SecondaryButton, SectionTitle } from '@/components/deadlines/ui';
import { ContractStatusPill } from '@/components/vo/ContractStatusPill';
import { useContract } from '@/hooks/use-contract';
import { useVoContract } from '@/hooks/use-vo-contract';
import { eventLabel, PARTY_LABEL, type ProjectEvent } from '@/lib/deadlines';
import { getSignedUrl } from '@/lib/signed-urls';
import { voCode } from '@/lib/variation-orders';
import {
  daysText,
  formatMoney,
  HISTORY_FIELD_LABEL,
  historyValue,
  VO_SOURCE_LABEL,
  voCurrentAmount,
  type VoAction,
  type VoHistoryEntry,
} from '@/lib/vo-contract';
import { useTheme } from '@/theme/use-theme';

const when = (iso: string) => formatShortDate(toSgt(new Date(iso)).date, true);

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View className={`flex-row justify-between gap-3 px-4 py-3 ${last ? '' : 'border-b border-border dark:border-border-dark'}`}>
      <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{label}</Text>
      <Text selectable className="shrink text-right font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
        {value}
      </Text>
    </View>
  );
}

type TimelineItem =
  | { kind: 'event'; at: string; key: string; event: ProjectEvent }
  | { kind: 'change'; at: string; key: string; changes: VoHistoryEntry[] };

/** The next thing that usually happens to a VO in this status. */
function nextStep(status: VoContractStatus, canConfirm: boolean): { action: VoAction; label: string } | null {
  switch (status) {
    case 'unconfirmed':
      return { action: 'confirmation', label: 'Log written confirmation' };
    case 'identified':
      return { action: 'instruction', label: 'Log instruction' };
    case 'instructed':
      return { action: 'quotation', label: 'Log quotation' };
    case 'quotation_submitted':
      return { action: 'valuation', label: 'Log valuation' };
    case 'valuation_issued':
    case 'disputed':
      return canConfirm ? { action: 'agree', label: 'Mark agreed' } : { action: 'objection', label: 'Log objection' };
    default:
      return null;
  }
}

export default function VoContractScreen() {
  const { id, voId } = useLocalSearchParams<{ id: string; voId: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const contract = useContract(id);
  const { vo, events, history, obligations, paymentClaims, loading, failed, reload } = useVoContract(voId);

  const currency = useMemo(() => {
    const cur = contract.fields.get('currency')?.value;
    const sum = contract.fields.get('contract_sum')?.value as { currency?: string } | undefined;
    return typeof cur === 'string' ? cur : sum?.currency ?? 'SGD';
  }, [contract.fields]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = events.map((e) => ({ kind: 'event', at: e.sent_at, key: `e-${e.id}`, event: e }));
    // Changes made by one action (same second, same person, same event) read as one line.
    const groups = new Map<string, VoHistoryEntry[]>();
    for (const h of history) {
      const k = `${h.changed_at.slice(0, 19)}|${h.changed_by}|${h.source_event_id ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), h]);
    }
    for (const [k, changes] of groups) items.push({ kind: 'change', at: changes[0].changed_at, key: `h-${k}`, changes });
    return items.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'event' ? -1 : 1));
  }, [events, history]);

  const documents = events.flatMap((e) => e.attachments.map((path) => ({ path, event: e })));
  const openDeadlines = obligations.filter((o) => o.status === 'open' || o.status === 'overdue' || o.status === 'suggested');

  const go = (action: VoAction, params: Record<string, string> = {}) =>
    router.push({ pathname: '/project/[id]/vo/contract/update', params: { id, voId, action, ...params } });

  const openFile = async (path: string) => {
    const url = await getSignedUrl('attachments', path);
    if (!url) return Alert.alert('Could not open the file', 'Check your connection and try again.');
    WebBrowser.openBrowserAsync(url);
  };

  if (loading && !vo) {
    return (
      <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
        <ActivityIndicator color={theme.accent} className="mt-16" />
      </View>
    );
  }
  if (!vo) {
    return (
      <View className="flex-1 bg-background px-6 dark:bg-background-dark" style={{ paddingTop: insets.top + 16 }}>
        <BackLink />
        <Text className="mt-4 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          {failed ? 'Could not load this variation order. Go back and try again.' : 'Variation order not found.'}
        </Text>
      </View>
    );
  }

  const c = vo.contract;
  const staff = contract.isStaff;
  const next = staff ? nextStep(c.status, contract.canConfirm) : null;
  const final = c.status === 'agreed' || c.status === 'rejected' || c.status === 'withdrawn';
  const statusMoves = (['disputed', 'rejected', 'withdrawn'] as const).filter((s) => canTransition(c.status, s));
  const current = voCurrentAmount(vo);

  return (
    <ScrollView
      className="flex-1 bg-background dark:bg-background-dark"
      contentContainerClassName="px-6"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={theme.accent} colors={[theme.accent]} />}>
      <BackLink />
      <Text className="mt-2 font-manrope-bold text-sm text-text-secondary dark:text-text-secondary-dark">{voCode(vo)} · Contract</Text>
      <Text accessibilityRole="header" className="mt-1 font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">
        {vo.name}
      </Text>
      <View className="mt-3 flex-row flex-wrap items-center gap-2">
        <ContractStatusPill status={c.status} />
        {c.isOmission && (
          <View className="rounded-full border border-border px-2.5 py-1 dark:border-border-dark">
            <Text className="font-manrope-semibold text-xs text-text-primary dark:text-text-primary-dark">Omission (reduces the sum)</Text>
          </View>
        )}
        <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">since {when(c.statusAt)}</Text>
      </View>

      {/* Large numeral: the one figure people come here for. */}
      <Text className="mt-4 font-manrope-bold text-3xl text-text-primary dark:text-text-primary-dark">{formatMoney(current, currency)}</Text>
      <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
        {c.status === 'agreed' ? 'Agreed' : c.assessed !== null ? 'Assessed, not yet agreed' : c.claimed !== null ? 'Claimed, not yet assessed' : 'No amount yet'}
      </Text>

      {c.status === 'unconfirmed' && (
        <View className={`${cardClass} mt-4 flex-row gap-3 border-amber-700 p-4 dark:border-amber-300`}>
          <Text className="flex-1 font-manrope text-sm text-text-primary dark:text-text-primary-dark">
            This was an oral instruction. Get it confirmed in writing (or a written instruction issued) within the contract period, or it may not count as a variation.
          </Text>
        </View>
      )}

      {next && (
        <View className="mt-5">
          <PrimaryButton label={next.label} onPress={() => go(next.action)} />
        </View>
      )}

      <SectionTitle>Amounts and time</SectionTitle>
      <View className={`${cardClass} overflow-hidden`}>
        <Row label="Claimed" value={formatMoney(c.claimed, currency)} />
        <Row label="Assessed" value={formatMoney(c.assessed, currency)} />
        <Row label="Agreed" value={formatMoney(c.agreed, currency)} />
        <Row label="Time claimed" value={daysText(c.timeClaimed)} />
        <Row label="Time agreed" value={daysText(c.timeAgreed)} />
        <Row label="Source" value={c.source ? VO_SOURCE_LABEL[c.source] : '—'} />
        <Row label="Instructed by" value={c.instructingParty ? PARTY_LABEL[c.instructingParty] : '—'} />
        <Row label="Instruction" value={c.instructionReference ?? '—'} last />
      </View>
      {(c.timeClaimed ?? 0) > 0 && c.status !== 'agreed' && (
        <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
          A time claim suggests an EOT notice deadline (once the EOT notice rule is verified). Confirm it on the deadline if it applies.
        </Text>
      )}

      {staff && !final && (
        <View className="mt-4 gap-2">
          {(['instruction', 'quotation', 'valuation', 'objection'] as const)
            .filter((a) => a !== next?.action)
            .filter((a) => (a === 'instruction' ? c.status === 'identified' || c.status === 'unconfirmed' : true))
            .map((a) => (
              <SecondaryButton
                key={a}
                icon={a === 'objection' ? 'alert' : 'file'}
                label={{ instruction: 'Log instruction', quotation: 'Log quotation', valuation: 'Log valuation', objection: 'Log objection' }[a]}
                onPress={() => go(a)}
              />
            ))}
          {contract.canConfirm && next?.action !== 'agree' && canTransition(c.status, 'agreed') && (
            <SecondaryButton icon="check" label="Mark agreed" onPress={() => go('agree')} />
          )}
        </View>
      )}
      {staff && (
        <View className="mt-2 gap-2">
          <SecondaryButton icon="list" label="Edit amounts and time" onPress={() => go('amounts')} />
          {statusMoves.length > 0 && (
            <View className="flex-row gap-2">
              {statusMoves.map((s) => (
                <View key={s} className="flex-1">
                  <SecondaryButton label={VO_STATUS_LABEL[s].replace(' (oral)', '')} onPress={() => go('status', { to: s })} />
                </View>
              ))}
            </View>
          )}
          <SecondaryButton
            icon="plus"
            label="Log another event or attach a file"
            onPress={() => router.push({ pathname: '/project/[id]/deadlines/log-event', params: { id, vo: voId } })}
          />
        </View>
      )}
      {!staff && (
        <Text className="mt-3 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          Only project owners and members can update the contractual side. Events and deadlines are not shown to guests.
        </Text>
      )}

      {staff && (
        <>
          <SectionTitle>Open deadlines</SectionTitle>
          {openDeadlines.length ? (
            openDeadlines.map((o) => <ObligationRow key={o.id} o={o} />)
          ) : (
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              {contract.live ? 'None for this VO.' : 'Deadlines are not live yet: confirm the required contract values first.'}
            </Text>
          )}
        </>
      )}

      {staff && (c.status === 'agreed' || paymentClaims.length > 0) && (
        <>
          <SectionTitle>Payment claims</SectionTitle>
          <Text className="font-manrope text-sm text-text-primary dark:text-text-primary-dark">
            {paymentClaims.length
              ? `Included in ${paymentClaims.map((p) => `${p.reference ?? 'claim'} (${when(p.sent_at)})`).join(', ')}`
              : 'Agreed but not yet included in a payment claim.'}
          </Text>
        </>
      )}

      <SectionTitle>Timeline</SectionTitle>
      <View className={`${cardClass} overflow-hidden`}>
        <TimelineLine title={`${voCode(vo)} raised`} detail={`${vo.sentByName ?? 'Former member'} · requested by ${vo.requestedBy}`} at={vo.sentAt} last={timeline.length === 0} />
        {timeline.map((item, i) =>
          item.kind === 'event' ? (
            <TimelineLine
              key={item.key}
              title={`${eventLabel(item.event.event_type)}${item.event.reference ? ` · ${item.event.reference}` : ''}`}
              detail={[
                item.event.raised_by_party && `${PARTY_LABEL[item.event.raised_by_party]}${item.event.addressed_to_party ? ` → ${PARTY_LABEL[item.event.addressed_to_party]}` : ''}`,
                item.event.notes,
                item.event.voided_at && 'Voided',
              ].filter(Boolean).join(' · ') || null}
              at={item.at}
              event
              last={i === timeline.length - 1}
            />
          ) : (
            <TimelineLine
              key={item.key}
              title={item.changes.map((h) => `${HISTORY_FIELD_LABEL[h.field] ?? h.field}: ${historyValue(h.field, h.old_value, currency)} → ${historyValue(h.field, h.new_value, currency)}`).join('\n')}
              detail={[item.changes[0].changer?.display_name ?? (item.changes[0].changed_by ? 'Former member' : 'Co-Atrium'), item.changes.find((h) => h.note)?.note].filter(Boolean).join(' · ')}
              at={item.at}
              last={i === timeline.length - 1}
            />
          ),
        )}
      </View>

      {staff && documents.length > 0 && (
        <>
          <SectionTitle>Documents</SectionTitle>
          <View className={`${cardClass} overflow-hidden`}>
            {documents.map((d, i) => (
              <Pressable
                key={d.path}
                accessibilityRole="button"
                accessibilityLabel={`Open file from ${eventLabel(d.event.event_type)}`}
                onPress={() => openFile(d.path)}
                className={`min-h-12 flex-row items-center justify-between gap-3 px-4 py-3 active:opacity-70 ${i === documents.length - 1 ? '' : 'border-b border-border dark:border-border-dark'}`}>
                <Text numberOfLines={1} className="flex-1 font-manrope text-sm text-text-primary dark:text-text-primary-dark">
                  {d.event.reference ?? eventLabel(d.event.event_type)} · file {d.event.attachments.indexOf(d.path) + 1}
                </Text>
                <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">Open</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <View className="mt-5">
        <SecondaryButton icon="thread" label="Open thread" onPress={() => router.push({ pathname: '/project/[id]/vo/[voId]', params: { id, voId } })} />
      </View>
      <Disclaimer />
    </ScrollView>
  );
}

function TimelineLine({ title, detail, at, event, last }: { title: string; detail: string | null; at: string; event?: boolean; last?: boolean }) {
  return (
    <View className={`flex-row gap-3 px-4 py-3 ${last ? '' : 'border-b border-border dark:border-border-dark'}`}>
      <View className={`mt-1.5 h-2 w-2 rounded-full ${event ? 'bg-text-primary dark:bg-text-primary-dark' : 'bg-border dark:bg-border-dark'}`} />
      <View className="flex-1 gap-0.5">
        <Text className={`font-manrope-semibold text-sm ${event ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>{title}</Text>
        {detail ? <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{detail}</Text> : null}
      </View>
      <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{when(at)}</Text>
    </View>
  );
}

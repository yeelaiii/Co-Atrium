import { VO_SOURCES, type VoSource } from '@shared/contracts/variations.ts';
import { formatShortDate, toSgt } from '@shared/deadlines/index.ts';
import type { Party } from '@shared/deadlines/rules.ts';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DateTimeField } from '@/components/deadlines/DateTimeField';
import { OptionSheet } from '@/components/OptionSheet';
import { MAX_ATTACHMENTS, PendingAttachments, RecordButton, usePhotoSource, useVoiceRecorder } from '@/components/vo/capture';
import { VoIcon } from '@/components/vo/icons';
import { PeoplePicker, splitPicks, type Picks } from '@/components/vo/PeoplePicker';
import { useObligations } from '@/hooks/use-obligations';
import { useProjectMembers } from '@/hooks/use-project-members';
import { eventLabel, PARTIES, PARTY_LABEL, requestObligations, type ProjectEvent } from '@/lib/deadlines';
import { invalidateQueries } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';
import { cleanLine, cleanMultiline, uploadAttachments, voErrorMessage, type LocalAttachment } from '@/lib/variation-orders';
import { VO_SOURCE_LABEL } from '@/lib/vo-contract';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme } from '@/theme/use-theme';

const inputClass =
  'min-h-[52px] rounded-button border border-border bg-surface px-4 font-manrope text-base text-text-primary focus:border-accent dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark dark:focus:border-accent-dark';

function Label({ text, optional = false, className = '' }: { text: string; optional?: boolean; className?: string }) {
  return (
    <Text className={`mb-2 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark ${className}`}>
      {text}
      {optional && <Text className="font-manrope text-text-secondary dark:text-text-secondary-dark"> (optional)</Text>}
    </Text>
  );
}

const MODES = [
  { key: 'scratch', label: 'From scratch' },
  { key: 'instruction', label: 'From an instruction' },
  { key: 'site', label: 'Site instruction' },
] as const;
type Mode = (typeof MODES)[number]['key'];
const NONE = 'None';

/**
 * Create a VO: from scratch, from an instruction already logged (AI / SOI), or "Record site
 * instruction" (someone on site asked for extra work: the VO starts unconfirmed and the written
 * confirmation deadline starts at once).
 */
export default function NewVariationOrder() {
  const { id, mode: initialMode } = useLocalSearchParams<{ id: string; mode?: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const me = session?.user.id;
  const { members, loading: membersLoading } = useProjectMembers(id);

  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [description, setDescription] = useState('');
  const [media, setMedia] = useState<LocalAttachment[]>([]);
  // Only the people picked here (and the sender) can see the VO.
  const [picks, setPicks] = useState<Picks>(new Map());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(MODES.some((m) => m.key === initialMode) ? (initialMode as Mode) : 'scratch');
  const [source, setSource] = useState<VoSource | null>(null);
  const [instructingParty, setInstructingParty] = useState<Party | null>(null);
  const [receivedAt, setReceivedAt] = useState(() => new Date());
  const [reference, setReference] = useState('');
  const [instructionId, setInstructionId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'source' | 'party' | 'instruction' | null>(null);
  const { events } = useObligations(id);
  // Instructions not yet tied to a VO.
  const instructions = useMemo(
    () => events.filter((e) => !e.variation_order_id && (e.event_type === 'instruction_issued' || e.event_type === 'oral_instruction_confirmed')),
    [events],
  );
  const instruction = instructions.find((e) => e.id === instructionId) ?? null;
  const instructionName = (e: ProjectEvent) => `${e.reference ?? eventLabel(e.event_type)} · ${formatShortDate(toSgt(new Date(e.sent_at)).date, true)}`;

  const recorder = useVoiceRecorder();
  const remaining = MAX_ATTACHMENTS - media.length;
  const { openPhotoSource, photoSheet } = usePhotoSource((photos) => setMedia((m) => [...m, ...photos]), remaining);

  const others = useMemo(() => members.filter((m) => m.user_id !== me), [members, me]);
  const { approvers, participants } = splitPicks(picks);
  const everyoneIncluded = others.length > 0 && others.every((m) => picks.has(m.user_id));

  const voName = name.trim();
  const voLocation = location.trim();
  const voRequestedBy = requestedBy.trim();
  const voDescription = description.trim();
  const valid =
    voName.length > 0 &&
    cleanLine(voName, 160) &&
    cleanLine(voLocation, 160) &&
    voRequestedBy.length > 0 &&
    cleanLine(voRequestedBy, 120) &&
    cleanMultiline(voDescription, 4000) &&
    (mode === 'scratch' ? approvers.length > 0 : true) &&
    (mode !== 'site' || (!!instructingParty && cleanLine(reference.trim(), 60))) &&
    (mode !== 'instruction' || !!instruction);
  const canSend = valid && !sending && !recorder.recording;

  const toggleEveryone = () =>
    setPicks((prev) => {
      if (everyoneIncluded) return new Map([...prev].filter(([, pick]) => pick === 'approver'));
      const next = new Map(prev);
      others.forEach((m) => next.has(m.user_id) || next.set(m.user_id, 'included'));
      return next;
    });

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const attachments = await uploadAttachments(id, media);
      let data: string;
      if (mode === 'site') {
        const res = await supabase.rpc('record_site_instruction', {
          pid: id,
          vo_name: voName,
          vo_requested_by: voRequestedBy,
          instructing_party: instructingParty,
          received_at: receivedAt.toISOString(),
          vo_location: voLocation || null,
          vo_description: voDescription || null,
          ev_reference: reference.trim().replace(/-$/, '') || null,
          attachments,
          approvers,
          participants,
        });
        if (res.error) throw res.error;
        data = (res.data as { variation_order_id: string }).variation_order_id;
        // Starts the written confirmation deadline now (cron catches up otherwise).
        await requestObligations(id);
      } else {
        const res = await supabase.rpc('create_variation_order', {
          pid: id,
          vo_name: voName,
          vo_requested_by: voRequestedBy,
          vo_location: voLocation || null,
          vo_description: voDescription || null,
          attachments,
          approvers,
          participants,
        });
        if (res.error) throw res.error;
        data = res.data as string;
        // The VO exists from here on; a failure below is reported but does not lose it.
        const follow =
          mode === 'instruction' && instruction
            ? await supabase.rpc('link_variation_instruction', { vid: data, eid: instruction.id })
            : source
              ? await supabase.rpc('update_variation_contract', { vid: data, patch: { source } })
              : null;
        if (follow?.error) {
          Alert.alert('VO created', `It was saved, but could not be ${mode === 'instruction' ? 'linked to the instruction' : 'given its source'}: ${voErrorMessage(follow.error)} You can set it on the VO's Contract screen.`);
        }
      }
      // Site instructions log a project event; events are not on Realtime.
      invalidateQueries(`project:${id}:obligations`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Back to the project with the new VO in front.
      router.dismissTo({ pathname: '/project/[id]', params: { id, vo: data as string } });
    } catch (e) {
      setError(voErrorMessage(e));
      setSending(false);
    }
  };

  const pickerButton = (label: string, value: string | null, kind: NonNullable<typeof sheet>, placeholder: string) => (
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
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background dark:bg-background-dark"
      style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="px-6 pt-4" contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => router.back()}
          hitSlop={8}
          className="min-h-11 justify-center self-start active:opacity-70">
          <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">‹ Cancel</Text>
        </Pressable>

        <Text accessibilityRole="header" className="mb-1 font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">
          New variation order
        </Text>
        <Text className="mb-6 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          Photograph the change, describe it, and choose who to include. Only the people you include can see it, and those marked as approvers are asked to approve. Everyone included gets a notification.
        </Text>

        <View accessibilityRole="tablist" className="mb-5 flex-row rounded-button border border-border bg-surface p-1 dark:border-border-dark dark:bg-surface-dark">
          {MODES.map((m) => {
            const selected = mode === m.key;
            return (
              <Pressable
                key={m.key}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setMode(m.key)}
                className={`min-h-11 flex-1 items-center justify-center rounded-lg px-1 ${selected ? 'bg-background dark:bg-background-dark' : ''} active:opacity-70`}>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  className={`font-manrope-semibold text-sm ${selected ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {mode === 'site' && (
          <View className="mb-5 gap-1">
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              Someone on site asked for work outside the contract. Record it now: the VO starts as unconfirmed and the deadline to confirm it in writing starts at once.
            </Text>
            <Label text="Instructed by (party)" className="mt-4" />
            {pickerButton('Instructed by', instructingParty ? PARTY_LABEL[instructingParty] : null, 'party', 'Choose who gave the instruction')}
            <Label text="When" className="mt-4" />
            <DateTimeField accessibilityLabel="When the instruction was given" value={receivedAt} onChange={setReceivedAt} maximumDate={new Date()} />
            <Label text="Reference" optional className="mt-4" />
            <TextInput
              accessibilityLabel="Reference"
              value={reference}
              onChangeText={setReference}
              placeholder="e.g. OI-003, site diary page"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="characters"
              maxLength={60}
              className={inputClass}
            />
          </View>
        )}

        {mode === 'instruction' && (
          <View className="mb-5">
            <Label text="Instruction" />
            {instructions.length === 0 ? (
              <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                No logged instructions without a VO. Log the instruction (AI / SOI) under Deadlines first, or start from scratch.
              </Text>
            ) : (
              pickerButton('Instruction', instruction ? instructionName(instruction) : null, 'instruction', 'Choose the instruction')
            )}
            <Text className="mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
              The instruction and its deadlines become part of this VO, so only the people you include will see them.
            </Text>
          </View>
        )}

        <Label text="Photos and voice note" optional />
        <View className="gap-3 rounded-card border border-border bg-surface p-3 dark:border-border-dark dark:bg-surface-dark">
          <PendingAttachments items={media} onRemove={(i) => setMedia((m) => m.filter((_, j) => j !== i))} />
          <View className="flex-row items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add photo"
              disabled={remaining <= 0 || sending}
              onPress={openPhotoSource}
              className={`min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-button border border-border dark:border-border-dark ${remaining <= 0 ? 'opacity-40' : 'active:opacity-70'}`}>
              <VoIcon name="camera" color={theme.textPrimary} size={20} />
              <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Add photo</Text>
            </Pressable>
            <View className="min-h-11 flex-1 flex-row items-center justify-center gap-1 rounded-button border border-border dark:border-border-dark">
              <RecordButton recorder={recorder} disabled={(remaining <= 0 && !recorder.recording) || sending} onRecorded={(v) => setMedia((m) => [...m, v])} />
              {!recorder.recording && (
                <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Voice note</Text>
              )}
            </View>
          </View>
        </View>

        <Label text="Name" className="mt-5" />
        <TextInput
          accessibilityLabel="Name"
          value={name}
          onChangeText={setName}
          placeholder="e.g. Relocate kitchen wall"
          placeholderTextColor={theme.textSecondary}
          maxLength={160}
          returnKeyType="next"
          className={inputClass}
        />

        <Label text="Location" optional className="mt-4" />
        <TextInput
          accessibilityLabel="Location"
          value={location}
          onChangeText={setLocation}
          placeholder="e.g. Level 2, Unit 4, grid C4"
          placeholderTextColor={theme.textSecondary}
          maxLength={160}
          className={inputClass}
        />

        <Label text="Requested by" className="mt-4" />
        <TextInput
          accessibilityLabel="Requested by"
          value={requestedBy}
          onChangeText={setRequestedBy}
          placeholder="e.g. Client, structural engineer"
          placeholderTextColor={theme.textSecondary}
          maxLength={120}
          className={inputClass}
        />

        {mode === 'scratch' && (
          <>
            <Label text="Source" optional className="mt-4" />
            {pickerButton('Source', source ? VO_SOURCE_LABEL[source] : null, 'source', 'e.g. contractor proposal, client request')}
          </>
        )}

        <Label text="Description" optional className="mt-4" />
        <TextInput
          accessibilityLabel="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="What changes, and why"
          placeholderTextColor={theme.textSecondary}
          maxLength={4000}
          multiline
          textAlignVertical="top"
          className={`${inputClass} min-h-28 py-3`}
        />

        <View className="mb-2 mt-5 flex-row items-center justify-between">
          <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Who to include</Text>
          {others.length > 1 && (
            <Pressable accessibilityRole="button" onPress={toggleEveryone} hitSlop={8} className="min-h-11 justify-center active:opacity-70">
              <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">
                {everyoneIncluded ? 'Clear' : 'Include everyone'}
              </Text>
            </Pressable>
          )}
        </View>
        {membersLoading ? (
          <ActivityIndicator color={theme.accent} />
        ) : others.length === 0 ? (
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            You are the only person in this project. Add people from the Members tab first.
          </Text>
        ) : (
          <>
            <PeoplePicker members={others} value={picks} onChange={setPicks} />
            <Text className="mt-2 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              {approvers.length === 0
                ? mode === 'scratch'
                  ? 'Mark at least one owner or member as an approver.'
                  : 'Approvers are optional here; include anyone who should see it.'
                : `${approvers.length} ${approvers.length === 1 ? 'approver' : 'approvers'}, ${participants.length} more included. Others in the project will not see this VO.`}
            </Text>
          </>
        )}

        {error && (
          <Text accessibilityRole="alert" className="mt-4 font-manrope text-sm text-red-700 dark:text-red-400">
            Error: {error}
          </Text>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend, busy: sending }}
          disabled={!canSend}
          onPress={send}
          className={`mt-6 min-h-12 items-center justify-center rounded-button bg-accent dark:bg-accent-dark ${canSend ? 'active:opacity-80' : 'opacity-40'}`}>
          {sending ? (
            <ActivityIndicator color={theme.textOnAccent} />
          ) : (
            <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">
              {mode === 'site'
                ? 'Record site instruction'
                : approvers.length > 0
                  ? `Send to ${approvers.length + participants.length} ${approvers.length + participants.length === 1 ? 'person' : 'people'}`
                  : mode === 'instruction'
                    ? 'Create VO'
                    : 'Send for approval'}
            </Text>
          )}
        </Pressable>
      </ScrollView>
      {photoSheet}
      <OptionSheet
        visible={!!sheet}
        title={sheet === 'source' ? 'Source' : sheet === 'party' ? 'Instructed by' : 'Instruction'}
        options={
          sheet === 'source'
            ? [...VO_SOURCES.map((x) => VO_SOURCE_LABEL[x]), NONE]
            : sheet === 'party'
              ? PARTIES.map((p) => PARTY_LABEL[p])
              : instructions.map(instructionName)
        }
        selected={sheet === 'source' ? (source ? VO_SOURCE_LABEL[source] : NONE) : sheet === 'party' ? (instructingParty ? PARTY_LABEL[instructingParty] : null) : instruction ? instructionName(instruction) : null}
        onSelect={(o) => {
          const kind = sheet;
          setSheet(null);
          if (kind === 'source') setSource(VO_SOURCES.find((x) => VO_SOURCE_LABEL[x] === o) ?? null);
          else if (kind === 'party') setInstructingParty(PARTIES.find((p) => PARTY_LABEL[p] === o) ?? null);
          else {
            const e = instructions.find((x) => instructionName(x) === o) ?? null;
            setInstructionId(e?.id ?? null);
            if (e && !name) setName(e.reference ? `${e.reference} works` : '');
            if (e?.raised_by_party && !requestedBy) setRequestedBy(PARTY_LABEL[e.raised_by_party]);
          }
        }}
        onClose={() => setSheet(null)}
      />
    </KeyboardAvoidingView>
  );
}

import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MAX_ATTACHMENTS, PendingAttachments, RecordButton, usePhotoSource, useVoiceRecorder } from '@/components/vo/capture';
import { VoIcon } from '@/components/vo/icons';
import { PeoplePicker, splitPicks, type Picks } from '@/components/vo/PeoplePicker';
import { useProjectMembers } from '@/hooks/use-project-members';
import { supabase } from '@/lib/supabase';
import { cleanLine, cleanMultiline, uploadAttachments, voErrorMessage, type LocalAttachment } from '@/lib/variation-orders';
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

export default function NewVariationOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
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
    approvers.length > 0;
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
      const { data, error: rpcError } = await supabase.rpc('create_variation_order', {
        pid: id,
        vo_name: voName,
        vo_requested_by: voRequestedBy,
        vo_location: voLocation || null,
        vo_description: voDescription || null,
        attachments,
        approvers,
        participants,
      });
      if (rpcError) throw rpcError;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Back to the project with the new VO in front.
      router.dismissTo({ pathname: '/project/[id]', params: { id, vo: data as string } });
    } catch (e) {
      setError(voErrorMessage(e));
      setSending(false);
    }
  };

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
                ? 'Mark at least one owner or member as an approver.'
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
              {approvers.length > 0 ? `Send to ${approvers.length + participants.length} ${approvers.length + participants.length === 1 ? 'person' : 'people'}` : 'Send for approval'}
            </Text>
          )}
        </Pressable>
      </ScrollView>
      {photoSheet}
    </KeyboardAvoidingView>
  );
}

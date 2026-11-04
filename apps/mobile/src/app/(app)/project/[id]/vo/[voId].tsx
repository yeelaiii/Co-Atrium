import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApproveButton } from '@/components/vo/ApproveButton';
import { ApproverList, IncludedList } from '@/components/vo/ApproverList';
import { MAX_ATTACHMENTS, PendingAttachments, RecordButton, usePhotoSource, useVoiceRecorder } from '@/components/vo/capture';
import { VoIcon } from '@/components/vo/icons';
import { PeoplePicker, type Picks } from '@/components/vo/PeoplePicker';
import { StatusBadge, useStatusColor } from '@/components/vo/StatusBadge';
import { VoiceNote } from '@/components/vo/VoiceNote';
import { PhotoStrip } from '@/components/vo/VoPhoto';
import { useMyRole } from '@/hooks/use-my-role';
import { useProjectMembers } from '@/hooks/use-project-members';
import { useVoThread, type ThreadAttachment, type ThreadEntry } from '@/hooks/use-vo-thread';
import { supabase } from '@/lib/supabase';
import {
  approvalProgress,
  cleanMultiline,
  formatSentAt,
  uploadAttachments,
  voBucket,
  voCode,
  voErrorMessage,
  type LocalAttachment,
  type VariationOrder,
} from '@/lib/variation-orders';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme } from '@/theme/use-theme';

type Item =
  | { type: 'opening'; key: string }
  | { type: 'entry'; key: string; entry: ThreadEntry }
  | { type: 'completed'; key: string; at: string };

function Media({ attachments }: { attachments: ThreadAttachment[] }) {
  const photos = attachments.filter((a) => a.kind === 'photo').map((a) => a.path);
  const voices = attachments.filter((a) => a.kind === 'voice');
  if (attachments.length === 0) return null;
  return (
    <View className="gap-2">
      <PhotoStrip paths={photos} />
      {voices.map((v) => (
        <VoiceNote key={v.id} path={v.path} durationMs={v.durationMs} transcript={v.transcript} />
      ))}
    </View>
  );
}

function OpeningPost({ vo, media }: { vo: VariationOrder; media: ThreadAttachment[] }) {
  return (
    <View className="gap-3 rounded-card border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
      <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
        {vo.sentByName ?? 'Former member'}
        <Text className="font-manrope text-text-secondary dark:text-text-secondary-dark"> sent {voCode(vo)} · {formatSentAt(vo.sentAt)}</Text>
      </Text>
      <View className="gap-1">
        {vo.location && <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Location: {vo.location}</Text>}
        <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Requested by: {vo.requestedBy}</Text>
      </View>
      {vo.description && (
        <Text selectable className="font-manrope text-base leading-6 text-text-primary dark:text-text-primary-dark">
          {vo.description}
        </Text>
      )}
      <Media attachments={media} />
    </View>
  );
}

function Comment({ entry, mine }: { entry: ThreadEntry; mine: boolean }) {
  return (
    <View
      className={`max-w-[88%] gap-2 rounded-card border p-3 ${mine ? 'self-end border-border bg-background dark:border-border-dark dark:bg-background-dark' : 'self-start border-border bg-surface dark:border-border-dark dark:bg-surface-dark'}`}>
      <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">
        {mine ? 'You' : (entry.authorName ?? 'Former member')} · {formatSentAt(entry.createdAt)}
      </Text>
      {entry.body && (
        <Text selectable className="font-manrope text-base leading-6 text-text-primary dark:text-text-primary-dark">
          {entry.body}
        </Text>
      )}
      <Media attachments={entry.attachments} />
    </View>
  );
}

/** System line in the thread: "<name> approved this VO", or the VO being completed. */
function LogLine({ text, at, accent = false }: { text: string; at: string; accent?: boolean }) {
  const green = useStatusColor('completed');
  return (
    <View accessible accessibilityLabel={`${text}, ${formatSentAt(at)}`} className="flex-row items-center justify-center gap-2 px-4 py-1">
      {accent && <View className="h-4 w-1 rounded-full bg-accent dark:bg-accent-dark" />}
      <VoIcon name="check" color={green} size={16} strokeWidth={2.4} />
      <Text className="shrink font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">{text}</Text>
      <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{formatSentAt(at)}</Text>
    </View>
  );
}

function AddPeopleSheet({ vo, projectId, visible, onClose, onAdded }: { vo: VariationOrder; projectId: string; visible: boolean; onClose: () => void; onAdded: () => void }) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { members } = useProjectMembers(projectId);
  const [picks, setPicks] = useState<Picks>(new Map());
  const [busy, setBusy] = useState(false);

  const existing = useMemo<Picks>(() => {
    const map: Picks = new Map(vo.participants.map((p) => [p.userId, 'included' as const]));
    vo.approvers.forEach((a) => a.userId && map.set(a.userId, 'approver'));
    return map;
  }, [vo]);
  const candidates = members.filter((m) => m.user_id !== vo.sentById);
  // Only what changed: new people, and existing people newly asked to approve.
  const changes = [...picks].filter(([uid, pick]) => existing.get(uid) !== pick && !(pick === 'included' && existing.has(uid)));
  const newApprovers = changes.filter(([, pick]) => pick === 'approver').map(([uid]) => uid);
  const newIncluded = changes.filter(([, pick]) => pick === 'included').map(([uid]) => uid);

  const close = () => {
    setPicks(new Map());
    onClose();
  };

  const add = async () => {
    setBusy(true);
    const results = await Promise.all([
      newIncluded.length ? supabase.rpc('add_variation_order_participants', { vid: vo.id, participants: newIncluded }) : null,
      newApprovers.length ? supabase.rpc('add_variation_order_approvers', { vid: vo.id, approvers: newApprovers }) : null,
    ]);
    setBusy(false);
    const failed = results.find((r) => r?.error);
    onAdded();
    if (failed?.error) return Alert.alert('Could not add everyone', voErrorMessage(failed.error));
    close();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <Pressable accessibilityLabel="Close" onPress={close} className="flex-1 justify-end bg-black/50">
        <Pressable
          onPress={() => {}}
          className="max-h-[80%] rounded-t-card border border-border bg-surface dark:border-border-dark dark:bg-surface-dark"
          style={{ paddingBottom: insets.bottom + 12 }}>
          <Text className="px-6 pb-1 pt-5 font-manrope-bold text-lg text-text-primary dark:text-text-primary-dark">Add people</Text>
          <Text className="px-6 pb-3 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            They will see the whole thread, including earlier messages, and get a notification.
          </Text>
          <ScrollView contentContainerClassName="px-4">
            <PeoplePicker members={candidates} value={picks} onChange={setPicks} existing={existing} allowApprovers={vo.status === 'pending'} />
          </ScrollView>
          <View className="px-6 pt-3">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: changes.length === 0 || busy, busy }}
              disabled={changes.length === 0 || busy}
              onPress={add}
              className={`min-h-12 items-center justify-center rounded-button bg-accent dark:bg-accent-dark ${changes.length === 0 || busy ? 'opacity-40' : 'active:opacity-80'}`}>
              {busy ? (
                <ActivityIndicator color={theme.textOnAccent} />
              ) : (
                <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">
                  {changes.length > 0 ? `Add ${changes.length}` : 'Add'}
                </Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Composer({ projectId, voId, onPosted }: { projectId: string; voId: string; onPosted: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [media, setMedia] = useState<LocalAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const recorder = useVoiceRecorder();
  const remaining = MAX_ATTACHMENTS - media.length;
  const { openPhotoSource, photoSheet } = usePhotoSource((photos) => setMedia((m) => [...m, ...photos]), remaining);

  const body = text.trim();
  const canSend = (body.length > 0 || media.length > 0) && cleanMultiline(body, 4000) && !sending && !recorder.recording;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const attachments = await uploadAttachments(projectId, media);
      const { error } = await supabase.rpc('post_variation_order_comment', {
        vid: voId,
        comment_body: body || null,
        attachments: attachments.length ? attachments : null,
      });
      if (error) throw error;
      setText('');
      setMedia([]);
      onPosted();
    } catch (e) {
      Alert.alert('Could not send', voErrorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <View className="gap-2 border-t border-border bg-surface px-3 pt-2 dark:border-border-dark dark:bg-surface-dark" style={{ paddingBottom: Math.max(insets.bottom, 8) }}>
      <PendingAttachments items={media} onRemove={(i) => setMedia((m) => m.filter((_, j) => j !== i))} />
      <View className="flex-row items-end gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add photo"
          disabled={remaining <= 0 || sending}
          onPress={openPhotoSource}
          className={`h-11 w-11 items-center justify-center ${remaining <= 0 ? 'opacity-40' : 'active:opacity-70'}`}>
          <VoIcon name="camera" color={theme.textSecondary} size={24} />
        </Pressable>
        {!recorder.recording && (
          <TextInput
            accessibilityLabel="Message"
            value={text}
            onChangeText={setText}
            placeholder="Add to the thread"
            placeholderTextColor={theme.textSecondary}
            selectionColor={theme.accent}
            multiline
            maxLength={4000}
            className="max-h-32 min-h-11 flex-1 rounded-button border border-border bg-background px-3 py-2.5 font-manrope text-base text-text-primary dark:border-border-dark dark:bg-background-dark dark:text-text-primary-dark"
          />
        )}
        {recorder.recording && (
          <Text className="min-h-11 flex-1 py-3 text-center font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
            Recording… tap stop when done
          </Text>
        )}
        <RecordButton recorder={recorder} disabled={(remaining <= 0 && !recorder.recording) || sending} onRecorded={(v) => setMedia((m) => [...m, v])} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend, busy: sending }}
          disabled={!canSend}
          onPress={send}
          className={`h-11 w-11 items-center justify-center rounded-full bg-accent dark:bg-accent-dark ${canSend ? 'active:opacity-80' : 'opacity-40'}`}>
          {sending ? <ActivityIndicator color={theme.textOnAccent} /> : <VoIcon name="send" color={theme.textOnAccent} size={20} />}
        </Pressable>
      </View>
      {photoSheet}
    </View>
  );
}

export default function VariationOrderThread() {
  const { id, voId } = useLocalSearchParams<{ id: string; voId: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const me = session?.user.id;
  const { role, canWrite } = useMyRole(id);
  const { vo, opening, entries, loading, failed, reload } = useVoThread(voId);
  const [showApprovers, setShowApprovers] = useState(false);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<FlatList<Item>>(null);

  const items = useMemo<Item[]>(() => {
    if (!vo) return [];
    const list: Item[] = [{ type: 'opening', key: 'opening' }, ...entries.map((entry) => ({ type: 'entry' as const, key: entry.id, entry }))];
    if (vo.approvedAt) list.push({ type: 'completed', key: 'completed', at: vo.approvedAt });
    return list;
  }, [vo, entries]);

  const bucket = vo ? voBucket(vo, me) : 'pending';
  // Sender (owner/member) or a project owner who can see it; approvers only while pending.
  const canAddPeople = !!vo && (role === 'owner' || (canWrite && vo.sentById === me));
  const progress = vo ? approvalProgress(vo) : { done: 0, total: 0 };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background dark:bg-background-dark"
      style={{ paddingTop: insets.top }}>
      <View className="gap-2 border-b border-border px-6 pb-3 pt-4 dark:border-border-dark">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={8}
          className="min-h-11 justify-center self-start active:opacity-70">
          <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">‹ Back</Text>
        </Pressable>
        {vo && (
          <>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="font-manrope-bold text-sm text-text-secondary dark:text-text-secondary-dark">{voCode(vo)} · Thread</Text>
              <StatusBadge bucket={bucket} />
            </View>
            <Text accessibilityRole="header" numberOfLines={2} className="font-manrope-bold text-xl text-text-primary dark:text-text-primary-dark">
              {vo.name}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showApprovers }}
              accessibilityLabel={`Approvals, ${progress.done} of ${progress.total}. Shared with ${vo.participants.length} people. ${showApprovers ? 'Hide' : 'Show'} people`}
              onPress={() => setShowApprovers((s) => !s)}
              className="min-h-11 flex-row items-center justify-between active:opacity-70">
              <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">
                {progress.total === 0 ? 'No approvers yet' : `Approvals · ${progress.done} of ${progress.total}`}
                <Text className="font-manrope text-text-secondary dark:text-text-secondary-dark"> · Shared with {vo.participants.length}</Text>
              </Text>
              <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">{showApprovers ? 'Hide' : 'Show'}</Text>
            </Pressable>
            {showApprovers && (
              <View className="gap-3">
                <ApproverList vo={vo} me={me} />
                <IncludedList vo={vo} me={me} />
                {canAddPeople && (
                  <Pressable accessibilityRole="button" onPress={() => setAdding(true)} className="min-h-11 flex-row items-center gap-1.5 self-start active:opacity-70">
                    <VoIcon name="plus" color={theme.accent} size={18} strokeWidth={2.4} />
                    <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">Add people</Text>
                  </Pressable>
                )}
              </View>
            )}
            {bucket === 'yours' && <ApproveButton vo={vo} onApproved={reload} />}
          </>
        )}
      </View>

      {loading && !vo ? (
        <ActivityIndicator color={theme.accent} className="mt-8" />
      ) : !vo ? (
        <Text className="px-6 pt-6 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          {failed ? 'Could not load this thread. Go back and try again.' : 'Variation order not found.'}
        </Text>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(item) => item.key}
          contentContainerClassName="gap-3 px-4 py-4"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            if (item.type === 'opening') return <OpeningPost vo={vo} media={opening} />;
            if (item.type === 'completed') return <LogLine text="All approvers have approved. VO completed." at={item.at} accent />;
            const { entry } = item;
            if (entry.kind === 'approval') {
              const who = entry.authorId === me ? 'You' : (entry.authorName ?? 'A former member');
              return <LogLine text={`${who} approved this VO`} at={entry.createdAt} />;
            }
            return <Comment entry={entry} mine={entry.authorId === me} />;
          }}
        />
      )}

      {vo && canWrite ? (
        <Composer projectId={id} voId={voId} onPosted={reload} />
      ) : vo && role ? (
        <View className="border-t border-border px-6 pt-3 dark:border-border-dark" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
          <Text className="text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            You can read this thread. Only owners and members can post.
          </Text>
        </View>
      ) : null}

      {vo && <AddPeopleSheet vo={vo} projectId={id} visible={adding} onClose={() => setAdding(false)} onAdded={reload} />}
    </KeyboardAvoidingView>
  );
}

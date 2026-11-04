import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native';

import { OptionSheet } from '@/components/OptionSheet';
import { formatDuration, type LocalAttachment, type LocalPhoto, type LocalVoice } from '@/lib/variation-orders';
import { useTheme } from '@/theme/use-theme';

import { VoIcon } from './icons';

export const MAX_ATTACHMENTS = 20; // per post, matches attach_vo_media()

const askForSettings = (what: string) =>
  Alert.alert(`${what} access is off`, `Turn on ${what.toLowerCase()} access for Co-Atrium in Settings to continue.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings() },
  ]);

const toPhotos = (result: ImagePicker.ImagePickerResult): LocalPhoto[] =>
  result.canceled ? [] : result.assets.map((a) => ({ kind: 'photo', uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg' }));

const CAMERA = 'Take photo';
const LIBRARY = 'Choose from library';

/** "Add photo" control: a sheet offering the camera or the photo library. */
export function usePhotoSource(onPicked: (photos: LocalPhoto[]) => void, remaining: number) {
  const [open, setOpen] = useState(false);

  const pick = async (source: string) => {
    setOpen(false);
    // Site photos are the main content: keep them sharp but well under the 25 MB upload limit.
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, exif: false };
    if (source === CAMERA) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return askForSettings('Camera');
      onPicked(toPhotos(await ImagePicker.launchCameraAsync(options)));
    } else {
      onPicked(
        toPhotos(
          await ImagePicker.launchImageLibraryAsync({ ...options, allowsMultipleSelection: true, selectionLimit: Math.max(1, remaining) }),
        ).slice(0, remaining),
      );
    }
  };

  const sheet = (
    <OptionSheet visible={open} title="Add photo" options={[CAMERA, LIBRARY]} selected={null} onSelect={pick} onClose={() => setOpen(false)} />
  );
  return { openPhotoSource: () => setOpen(true), photoSheet: sheet };
}

/** Records one voice note at a time (AAC .m4a). */
export function useVoiceRecorder() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);

  const start = useCallback(async () => {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) return askForSettings('Microphone');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [recorder]);

  /** Resolves to the recording, or null if it was too short to keep. */
  const stop = useCallback(async (): Promise<LocalVoice | null> => {
    const durationMs = recorder.getStatus().durationMillis;
    await recorder.stop();
    // Leave recording mode so playback uses the loudspeaker on iOS.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!recorder.uri || durationMs < 500) return null;
    return { kind: 'voice', uri: recorder.uri, durationMs };
  }, [recorder]);

  return { recording: state.isRecording, durationMs: state.durationMillis, start, stop };
}

/** Round mic button that turns into a stop button with a timer while recording. */
export function RecordButton({
  recorder,
  onRecorded,
  disabled = false,
}: {
  recorder: ReturnType<typeof useVoiceRecorder>;
  onRecorded: (voice: LocalVoice) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const toggle = async () => {
    if (recorder.recording) {
      const voice = await recorder.stop();
      if (voice) onRecorded(voice);
    } else {
      await recorder.start();
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recorder.recording ? `Stop recording, ${formatDuration(recorder.durationMs)}` : 'Record voice note'}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={toggle}
      className={`h-11 min-w-11 flex-row items-center justify-center gap-1.5 rounded-full px-2 ${recorder.recording ? 'bg-accent dark:bg-accent-dark' : ''} ${disabled ? 'opacity-40' : 'active:opacity-70'}`}>
      <VoIcon name={recorder.recording ? 'stop' : 'mic'} color={recorder.recording ? theme.textOnAccent : theme.textSecondary} size={recorder.recording ? 18 : 24} />
      {recorder.recording && (
        <Text className="font-manrope-semibold text-sm text-text-on-accent dark:text-text-on-accent-dark">{formatDuration(recorder.durationMs)}</Text>
      )}
    </Pressable>
  );
}

/** Not-yet-sent photos and voice notes, each removable. */
export function PendingAttachments({ items, onRemove }: { items: LocalAttachment[]; onRemove: (index: number) => void }) {
  const theme = useTheme();
  if (items.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 py-1" keyboardShouldPersistTaps="handled">
      {items.map((item, i) => (
        <View key={item.uri} className="relative">
          {item.kind === 'photo' ? (
            <Image source={{ uri: item.uri }} style={{ width: 72, height: 72, borderRadius: 10 }} contentFit="cover" />
          ) : (
            <View className="h-[72px] w-[88px] items-center justify-center gap-1 rounded-button border border-border bg-surface dark:border-border-dark dark:bg-surface-dark">
              <VoIcon name="mic" color={theme.textSecondary} size={20} />
              <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">{formatDuration(item.durationMs)}</Text>
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.kind === 'photo' ? 'photo' : 'voice note'} ${i + 1}`}
            onPress={() => onRemove(i)}
            hitSlop={10}
            className="absolute -right-1.5 -top-1.5 h-7 w-7 items-center justify-center rounded-full border border-border bg-surface active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
            <VoIcon name="close" color={theme.textPrimary} size={14} strokeWidth={2.4} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

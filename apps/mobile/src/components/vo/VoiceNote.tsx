import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { Transcript } from '@/hooks/use-vo-thread';
import { useSignedUrl } from '@/lib/signed-urls';
import { formatDuration } from '@/lib/variation-orders';
import { useTheme } from '@/theme/use-theme';

import { VoIcon } from './icons';

function TranscriptText({ transcript }: { transcript: Transcript }) {
  if (!transcript) return null;
  const pending = transcript.status === 'pending' || transcript.status === 'processing';
  return (
    <View className="gap-1 border-t border-border pt-2 dark:border-border-dark">
      <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">Transcript</Text>
      <Text
        selectable
        className={
          transcript.status === 'done' && transcript.text
            ? 'font-manrope text-sm leading-5 text-text-primary dark:text-text-primary-dark'
            : 'font-manrope text-sm italic text-text-secondary dark:text-text-secondary-dark'
        }>
        {transcript.status === 'done' ? transcript.text || '(No speech detected)' : pending ? 'Transcribing…' : 'Transcript unavailable.'}
      </Text>
    </View>
  );
}

/** A voice note from the private 'audio' bucket, with play/pause, progress and its transcript. */
export function VoiceNote({ path, durationMs, transcript }: { path: string; durationMs: number | null; transcript: Transcript }) {
  const theme = useTheme();
  const url = useSignedUrl('audio', path);
  const player = useAudioPlayer(url ? { uri: url } : null);
  const status = useAudioPlayerStatus(player);

  const total = status.duration > 0 ? status.duration * 1000 : (durationMs ?? 0);
  const elapsed = status.currentTime * 1000;
  const progress = total > 0 ? Math.min(1, elapsed / total) : 0;

  // Rewind at the end so the next tap plays from the start.
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      player.seekTo(0);
    }
  }, [status.didJustFinish, player]);

  const toggle = async () => {
    if (status.playing) {
      player.pause();
      return;
    }
    // Play through the speaker even with the silent switch on (site use).
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    player.play();
  };

  return (
    <View className="gap-2 rounded-button border border-border bg-background p-3 dark:border-border-dark dark:bg-background-dark">
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? 'Pause voice note' : `Play voice note, ${formatDuration(total)}`}
          disabled={!url}
          onPress={toggle}
          className="h-11 w-11 items-center justify-center rounded-full bg-accent active:opacity-80 dark:bg-accent-dark">
          {!url ? (
            <ActivityIndicator color={theme.textOnAccent} />
          ) : (
            <VoIcon name={status.playing ? 'pause' : 'play'} color={theme.textOnAccent} size={18} />
          )}
        </Pressable>
        <View className="flex-1 gap-1.5">
          <View className="h-1 overflow-hidden rounded-full bg-border dark:bg-border-dark">
            <View className="h-1 rounded-full bg-accent dark:bg-accent-dark" style={{ width: `${progress * 100}%` }} />
          </View>
          <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
            Voice note · {status.playing || elapsed > 0 ? `${formatDuration(elapsed)} / ` : ''}
            {formatDuration(total)}
          </Text>
        </View>
      </View>
      <TranscriptText transcript={transcript} />
    </View>
  );
}

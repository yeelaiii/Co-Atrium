import { Image, type ImageStyle } from 'expo-image';
import { useState } from 'react';
import { Modal, Pressable, Text, View, type StyleProp } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSignedUrl } from '@/lib/signed-urls';
import { useTheme } from '@/theme/use-theme';

import { VoIcon } from './icons';

/** A photo from the private 'attachments' bucket. The storage path is the disk-cache key. */
export function VoPhoto({ path, style, contentFit = 'cover' }: { path: string; style?: StyleProp<ImageStyle>; contentFit?: 'cover' | 'contain' }) {
  const url = useSignedUrl('attachments', path);
  return (
    <Image
      source={url ? { uri: url, cacheKey: path } : null}
      style={style}
      contentFit={contentFit}
      transition={150}
      recyclingKey={path}
      accessibilityIgnoresInvertColors
    />
  );
}

/** Full-screen, letterboxed view of one photo. */
export function PhotoViewer({ path, onClose }: { path: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!path} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 bg-black">
        {path && <VoPhoto path={path} contentFit="contain" style={{ flex: 1 }} />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          onPress={onClose}
          hitSlop={8}
          style={{ top: insets.top + 8 }}
          className="absolute right-4 h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-70">
          <VoIcon name="close" color="#FFFFFF" />
        </Pressable>
      </View>
    </Modal>
  );
}

/** Row of square thumbnails; tapping one opens it full screen. */
export function PhotoStrip({ paths, size = 88 }: { paths: string[]; size?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  if (paths.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {paths.map((path, i) => (
        <Pressable
          key={path}
          accessibilityRole="imagebutton"
          accessibilityLabel={`Photo ${i + 1} of ${paths.length}. Open full screen`}
          onPress={() => setOpen(path)}
          className="overflow-hidden rounded-button border border-border active:opacity-80 dark:border-border-dark">
          <VoPhoto path={path} style={{ width: size, height: size }} />
        </Pressable>
      ))}
      <PhotoViewer path={open} onClose={() => setOpen(null)} />
    </View>
  );
}

/** Shown where a VO's main photo would be when it was sent without one. */
export function NoPhoto({ style }: { style?: StyleProp<ImageStyle> }) {
  const theme = useTheme();
  return (
    <View style={style as never} className="items-center justify-center gap-2 bg-surface dark:bg-surface-dark">
      <VoIcon name="image" color={theme.textSecondary} size={36} strokeWidth={1.5} />
      <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">No photo attached</Text>
    </View>
  );
}

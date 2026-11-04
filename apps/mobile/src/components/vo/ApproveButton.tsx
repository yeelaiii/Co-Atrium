import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text } from 'react-native';

import { supabase } from '@/lib/supabase';
import { voCode, voErrorMessage, type VariationOrder } from '@/lib/variation-orders';
import { useTheme } from '@/theme/use-theme';

import { VoIcon } from './icons';

/**
 * Primary "Approve" action for someone asked to approve a VO. Confirms first (approvals are
 * permanent), then the server logs "<name> approved this VO" in the thread.
 */
export function ApproveButton({ vo, onApproved }: { vo: VariationOrder; onApproved?: () => void }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('approve_variation_order', { vid: vo.id });
    setBusy(false);
    if (error) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not approve', voErrorMessage(error));
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onApproved?.();
  };

  const confirm = () =>
    Alert.alert(`Approve ${voCode(vo)}?`, `"${vo.name}" will be marked as approved by you. This is added to the thread and can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Approve', onPress: approve },
    ]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Approve ${voCode(vo)}, ${vo.name}`}
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={confirm}
      className={`min-h-12 flex-row items-center justify-center gap-2 rounded-button bg-accent px-5 dark:bg-accent-dark ${busy ? 'opacity-60' : 'active:opacity-80'}`}>
      {busy ? (
        <ActivityIndicator color={theme.textOnAccent} />
      ) : (
        <>
          <VoIcon name="check" color={theme.textOnAccent} size={20} strokeWidth={2.4} />
          <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">Approve</Text>
        </>
      )}
    </Pressable>
  );
}

import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { useVariationOrders } from '@/hooks/use-variation-orders';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme } from '@/theme/use-theme';

import { TriageView } from './TriageView';
import { VoListView } from './VoListView';
import { VoIcon } from './icons';

const MODES = [
  { key: 'triage', label: 'Triage', icon: 'triage' },
  { key: 'list', label: 'List', icon: 'list' },
] as const;
type Mode = (typeof MODES)[number]['key'];

type Props = {
  projectId: string;
  data: ReturnType<typeof useVariationOrders>;
  canCreate: boolean;
  /** Open triage on this VO (e.g. from a notification). */
  focusVoId?: string;
};

/** The Variation orders tab of a project: triage (one at a time) or a list grouped by status. */
export function VariationOrdersPanel({ projectId, data, canCreate, focusVoId }: Props) {
  const theme = useTheme();
  const { session } = useAuth();
  const me = session?.user.id;
  const [mode, setMode] = useState<Mode>('triage');
  // Bumped to remount triage on a chosen VO when it is opened from the list.
  const [focus, setFocus] = useState<{ id?: string; key: number }>({ id: focusVoId, key: 0 });

  // A notification for another VO arrived while this screen was already open.
  const [seenFocus, setSeenFocus] = useState(focusVoId);
  if (focusVoId !== seenFocus) {
    setSeenFocus(focusVoId);
    if (focusVoId) {
      setFocus((f) => ({ id: focusVoId, key: f.key + 1 }));
      setMode('triage');
    }
  }

  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-3 px-6 pb-1 pt-3">
        <View accessibilityRole="tablist" className="flex-1 flex-row rounded-button border border-border bg-surface p-1 dark:border-border-dark dark:bg-surface-dark">
          {MODES.map(({ key, label, icon }) => {
            const selected = mode === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={`${label} view`}
                onPress={() => setMode(key)}
                className={`min-h-11 flex-1 flex-row items-center justify-center gap-1.5 rounded-lg ${selected ? 'bg-background dark:bg-background-dark' : ''} active:opacity-70`}>
                <VoIcon name={icon} color={selected ? theme.textPrimary : theme.textSecondary} size={18} />
                <Text
                  className={`font-manrope-semibold text-sm ${selected ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {canCreate && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New variation order"
            onPress={() => router.push({ pathname: '/project/[id]/vo/new', params: { id: projectId } })}
            className="min-h-12 flex-row items-center gap-1 rounded-button border border-accent px-3 active:opacity-70 dark:border-accent-dark">
            <VoIcon name="plus" color={theme.accent} size={18} strokeWidth={2.4} />
            <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">New VO</Text>
          </Pressable>
        )}
      </View>

      {mode === 'triage' ? (
        <TriageView
          key={focus.key}
          variationOrders={data.variationOrders}
          me={me}
          initialVoId={focus.id}
          loading={data.loading}
          failed={data.failed}
          reload={data.reload}
        />
      ) : (
        <VoListView
          variationOrders={data.variationOrders}
          me={me}
          loading={data.loading}
          failed={data.failed}
          reload={data.reload}
          onOpen={(vo) => {
            setFocus((f) => ({ id: vo.id, key: f.key + 1 }));
            setMode('triage');
          }}
        />
      )}
    </View>
  );
}

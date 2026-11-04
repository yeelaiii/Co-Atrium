import { Pressable, Text, View } from 'react-native';

import type { Member } from '@/hooks/use-project-members';
import { roleLabel } from '@/lib/projects';
import { useTheme } from '@/theme/use-theme';

import { VoIcon } from './icons';

/** Per person: not in the VO, included (can see it), or included and asked to approve. */
export type PersonPick = 'included' | 'approver';
export type Picks = Map<string, PersonPick>;

// Guests and viewers can be included (they read the thread) but can't approve (migration 0016).
export const canApprove = (m: { role: Member['role'] }) => m.role === 'owner' || m.role === 'member';

type Props = {
  members: Member[];
  value: Picks;
  onChange: (next: Picks) => void;
  /** People already in the VO: shown checked and can't be removed (only upgraded to approver). */
  existing?: Picks;
  /** False once the VO is approved: nobody new can be asked to approve. */
  allowApprovers?: boolean;
};

/** Checklist of project members: include each one, and optionally ask them to approve. */
export function PeoplePicker({ members, value, onChange, existing = new Map(), allowApprovers = true }: Props) {
  const theme = useTheme();

  const set = (uid: string, pick: PersonPick | null) => {
    const next = new Map(value);
    if (pick) next.set(uid, pick);
    else next.delete(uid);
    onChange(next);
  };

  return (
    <View className="overflow-hidden rounded-card border border-border bg-surface dark:border-border-dark dark:bg-surface-dark">
      {members.map((m, i) => {
        const had = existing.get(m.user_id);
        const pick = value.get(m.user_id) ?? had;
        const included = !!pick;
        const approver = pick === 'approver';
        const name = m.display_name ?? 'Unnamed';
        const showApprove = allowApprovers && canApprove(m);
        return (
          <View
            key={m.user_id}
            className={`min-h-16 flex-row items-center gap-3 px-4 py-2 ${i > 0 ? 'border-t border-border dark:border-border-dark' : ''}`}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: included, disabled: !!had }}
              accessibilityLabel={`Include ${name}, ${roleLabel(m.role)}`}
              disabled={!!had}
              onPress={() => set(m.user_id, included ? null : 'included')}
              className="min-h-12 flex-1 flex-row items-center gap-3 active:opacity-70">
              <View
                className={`h-6 w-6 items-center justify-center rounded-md border-2 ${included ? 'border-accent bg-accent dark:border-accent-dark dark:bg-accent-dark' : 'border-border dark:border-border-dark'} ${had ? 'opacity-50' : ''}`}>
                {included && <VoIcon name="check" color={theme.textOnAccent} size={16} strokeWidth={3} />}
              </View>
              <View className="flex-1">
                <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{name}</Text>
                <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                  {[roleLabel(m.role), m.job_role, m.company_name].filter(Boolean).join(' · ')}
                  {had ? ' · Already included' : ''}
                </Text>
              </View>
            </Pressable>
            {showApprove && (
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: approver, disabled: had === 'approver' }}
                accessibilityLabel={`${name} needs to approve`}
                disabled={had === 'approver'}
                onPress={() => set(m.user_id, approver ? 'included' : 'approver')}
                hitSlop={4}
                className={`min-h-11 flex-row items-center gap-1 rounded-full border px-3 ${approver ? 'border-accent bg-accent dark:border-accent-dark dark:bg-accent-dark' : 'border-border dark:border-border-dark'} ${had === 'approver' ? 'opacity-50' : 'active:opacity-70'}`}>
                {approver && <VoIcon name="check" color={theme.textOnAccent} size={14} strokeWidth={2.6} />}
                <Text
                  className={`font-manrope-semibold text-xs ${approver ? 'text-text-on-accent dark:text-text-on-accent-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
                  Approver
                </Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** Splits picks into the RPC arguments. Approvers are included automatically by the server. */
export const splitPicks = (picks: Picks) => {
  const approvers: string[] = [];
  const participants: string[] = [];
  picks.forEach((pick, uid) => (pick === 'approver' ? approvers : participants).push(uid));
  return { approvers, participants };
};

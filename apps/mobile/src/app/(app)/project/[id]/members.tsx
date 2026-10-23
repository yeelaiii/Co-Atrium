import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronDown } from '@/components/ChevronDown';
import { OptionSheet } from '@/components/OptionSheet';
import { useProjectMembers, type Member } from '@/hooks/use-project-members';
import { INVITE_ROLES, roleLabel } from '@/lib/projects';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme } from '@/theme/use-theme';

const REMOVE_OPTION = 'Remove from project';
const ROLE_OPTIONS = [...INVITE_ROLES.map((r) => r.label), REMOVE_OPTION];

const rowClass =
  'min-h-14 flex-row items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 dark:border-border-dark dark:bg-surface-dark';

export default function ProjectMembers() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const { members, pending, loading, failed, isOwner, setRole, remove, revoke } = useProjectMembers(id);
  const [target, setTarget] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: Promise<boolean>) => {
    setError(null);
    if (!(await action)) setError('That change could not be saved. Check your connection and try again.');
  };

  const onPick = (option: string) => {
    const member = target;
    setTarget(null);
    if (!member) return;
    if (option === REMOVE_OPTION) {
      Alert.alert('Remove from project?', `${member.display_name ?? 'This person'} will lose access.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => run(remove(member.user_id)) },
      ]);
      return;
    }
    const role = INVITE_ROLES.find((r) => r.label === option)?.role;
    if (role && role !== member.role) run(setRole(member.user_id, role));
  };

  const owners = members.filter((m) => m.role === 'owner');
  // Owners can't be edited here: demoting or removing one goes through transferring ownership.
  const editable = (m: Member) => isOwner && m.role !== 'owner' && m.user_id !== session?.user.id;

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="gap-3 px-6 pb-10 pt-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={8}
          className="min-h-11 justify-center self-start active:opacity-70">
          <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">‹ Back</Text>
        </Pressable>

        <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Members</Text>

        {isOwner && (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/project/[id]/invite', params: { id } })}
            className="min-h-12 items-center justify-center rounded-button bg-accent active:opacity-80 dark:bg-accent-dark">
            <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">Add person</Text>
          </Pressable>
        )}

        {error && (
          <Text accessibilityRole="alert" className="font-manrope text-sm text-red-700 dark:text-red-400">
            Error: {error}
          </Text>
        )}

        {loading ? (
          <ActivityIndicator color={theme.accent} className="mt-8" />
        ) : failed ? (
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            Could not load members. Go back and try again.
          </Text>
        ) : (
          <>
            {members.map((member) => {
              const body = (
                <>
                  <View className="flex-1">
                    <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">
                      {member.display_name ?? 'Unnamed'}
                      {member.user_id === session?.user.id ? ' (you)' : ''}
                    </Text>
                    {(member.company_name || member.job_role) && (
                      <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                        {[member.job_role, member.company_name].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </View>
                  <View className="flex-row items-center gap-1">
                    <Text className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
                      {roleLabel(member.role)}
                    </Text>
                    {editable(member) && <ChevronDown size={18} />}
                  </View>
                </>
              );
              return editable(member) ? (
                <Pressable
                  key={member.user_id}
                  accessibilityRole="button"
                  accessibilityLabel={`${member.display_name ?? 'Member'}, ${roleLabel(member.role)}. Change role`}
                  onPress={() => setTarget(member)}
                  className={`${rowClass} active:opacity-70`}>
                  {body}
                </Pressable>
              ) : (
                <View key={member.user_id} className={rowClass}>
                  {body}
                </View>
              );
            })}

            {isOwner && owners.length === 1 && members.length === 1 && pending.length === 0 && (
              <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                You are the only person here. Add people to share this project.
              </Text>
            )}

            {pending.length > 0 && (
              <>
                <Text className="mt-4 font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
                  Waiting to accept
                </Text>
                {pending.map((invite) => (
                  <View key={invite.invite_id} className={rowClass}>
                    <View className="flex-1">
                      <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{invite.email}</Text>
                      <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                        {roleLabel(invite.role)} · Pending
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Cancel invite for ${invite.email}`}
                      onPress={() => run(revoke(invite.invite_id))}
                      hitSlop={8}
                      className="min-h-11 justify-center px-2 active:opacity-70">
                      <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">Cancel</Text>
                    </Pressable>
                  </View>
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>

      <OptionSheet
        visible={!!target}
        title={target ? `Role for ${target.display_name ?? 'member'}` : ''}
        options={ROLE_OPTIONS}
        selected={target ? roleLabel(target.role) : null}
        onSelect={onPick}
        onClose={() => setTarget(null)}
      />
    </View>
  );
}

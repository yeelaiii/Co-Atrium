import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { ChevronDown } from '@/components/ChevronDown';
import { OptionSheet } from '@/components/OptionSheet';
import { useProjectMembers, type Member } from '@/hooks/use-project-members';
import { PARTIES, PARTY_LABEL } from '@/lib/deadlines';
import { INVITE_ROLES, isConfirmingRole, JOB_ROLES, jobRoleLabel, roleLabel } from '@/lib/projects';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme } from '@/theme/use-theme';

const CHANGE_ROLE = 'Change role';
const CHANGE_PARTY = 'Change contract party';
const CHANGE_ACCESS = 'Change access';
const REMOVE_OPTION = 'Remove from project';
const MENU_OPTIONS = [CHANGE_ROLE, CHANGE_PARTY, CHANGE_ACCESS, REMOVE_OPTION];
const OWNER_MENU_OPTIONS = [CHANGE_ROLE, CHANGE_PARTY];
const NO_ROLE = 'No role';
const ROLE_OPTIONS = [...JOB_ROLES.map((r) => (r.confirms ? `${r.label} (confirms contract)` : r.label)), NO_ROLE];
const NO_PARTY = 'Not set';
const PARTY_OPTIONS = [...PARTIES.map((p) => PARTY_LABEL[p]), NO_PARTY];
const ACCESS_OPTIONS = INVITE_ROLES.map((r) => r.label);

// One sheet, whose contents change: swapping content avoids presenting a second Modal while the
// first is still animating out (which iOS drops).
type Sheet = { member: Member; kind: 'menu' | 'access' | 'job_role' | 'party' };

const rowClass =
  'min-h-14 flex-row items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 dark:border-border-dark dark:bg-surface-dark';

/** The Members tab of a project: roster, pending invites and (for owners) role, party and access changes. */
export function MembersPanel({ projectId: id }: { projectId: string }) {
  const theme = useTheme();
  const { session } = useAuth();
  const { members, pending, loading, failed, isOwner, setRole, setJobRole, setContractParty, remove, revoke } =
    useProjectMembers(id);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: Promise<boolean>) => {
    setError(null);
    if (!(await action)) setError('That change could not be saved. Check your connection and try again.');
  };

  const owners = members.filter((m) => m.role === 'owner');
  // Owners set everyone's role and party, their own included. Access can't be changed for owners (demoting
  // or removing one goes through transferring ownership) or for yourself.
  const accessEditable = (m: Member) => isOwner && m.role !== 'owner' && m.user_id !== session?.user.id;

  const open = (member: Member) => setSheet({ member, kind: 'menu' });

  const onPick = (option: string) => {
    if (!sheet) return;
    const { member, kind } = sheet;
    if (kind === 'menu' && option !== REMOVE_OPTION) {
      const next = { [CHANGE_ACCESS]: 'access', [CHANGE_PARTY]: 'party' }[option];
      setSheet({ member, kind: (next ?? 'job_role') as Sheet['kind'] });
      return;
    }
    setSheet(null);
    if (kind === 'menu') {
      Alert.alert('Remove from project?', `${member.display_name ?? 'This person'} will lose access.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => run(remove(member.user_id)) },
      ]);
    } else if (kind === 'party') {
      const party = PARTIES.find((p) => PARTY_LABEL[p] === option) ?? null;
      if (party !== member.contract_party) run(setContractParty(member.user_id, party));
    } else if (kind === 'access') {
      const role = INVITE_ROLES.find((r) => r.label === option)?.role;
      if (role && role !== member.role) run(setRole(member.user_id, role));
    } else {
      const jobRole = JOB_ROLES[ROLE_OPTIONS.indexOf(option)]?.role ?? null;
      if (jobRole !== member.job_role) run(setJobRole(member.user_id, jobRole));
    }
  };

  const name = (m: Member) => m.display_name ?? 'member';
  const sheetContent = !sheet
    ? { title: '', options: [], selected: null }
    : sheet.kind === 'menu'
      ? { title: sheet.member.display_name ?? 'Member', options: accessEditable(sheet.member) ? MENU_OPTIONS : OWNER_MENU_OPTIONS, selected: null }
      : sheet.kind === 'party'
        ? {
            title: `${name(sheet.member)} acts for`,
            options: PARTY_OPTIONS,
            selected: sheet.member.contract_party ? PARTY_LABEL[sheet.member.contract_party] : NO_PARTY,
          }
      : sheet.kind === 'access'
        ? { title: `Access for ${name(sheet.member)}`, options: ACCESS_OPTIONS, selected: roleLabel(sheet.member.role) }
        : {
            title: `Role for ${name(sheet.member)}`,
            options: ROLE_OPTIONS,
            selected: ROLE_OPTIONS[JOB_ROLES.findIndex((r) => r.role === sheet.member.job_role)] ?? NO_ROLE,
          };

  return (
    <View className="flex-1">
      <ScrollView contentContainerClassName="gap-3 px-6 pb-10 pt-4">
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
                        {[jobRoleLabel(member.job_role), member.company_name].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                    {(member.contract_party || isConfirmingRole(member.job_role)) && (
                      <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
                        {[
                          member.contract_party && `For ${PARTY_LABEL[member.contract_party].toLowerCase()}`,
                          isConfirmingRole(member.job_role) && 'Confirms contract',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    )}
                  </View>
                  <View className="flex-row items-center gap-1">
                    <Text className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
                      {roleLabel(member.role)}
                    </Text>
                    {isOwner && <ChevronDown size={18} />}
                  </View>
                </>
              );
              return isOwner ? (
                <Pressable
                  key={member.user_id}
                  accessibilityRole="button"
                  accessibilityLabel={`${[member.display_name ?? 'Member', jobRoleLabel(member.job_role), roleLabel(member.role)].filter(Boolean).join(', ')}. Edit`}
                  onPress={() => open(member)}
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
        visible={!!sheet}
        title={sheetContent.title}
        options={sheetContent.options}
        selected={sheetContent.selected}
        onSelect={onPick}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { useProjects, type ProjectSummary } from '@/hooks/use-projects';
import { PROJECT_STATUSES, roleLabel } from '@/lib/projects';
import { useMyInvites, type MyInvite } from '@/providers/InvitesProvider';
import { useTheme } from '@/theme/use-theme';

function InviteCard({ invite, onRespond }: { invite: MyInvite; onRespond: (id: string, accept: boolean) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    const failure = await onRespond(invite.invite_id, accept);
    // On success the card unmounts with the refreshed list; only a failure needs showing.
    if (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <View className="gap-3 rounded-card border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
      <View className="flex-row gap-3">
        <View className="w-1.5 rounded-full bg-accent dark:bg-accent-dark" />
        <View className="flex-1">
          <Text className="font-manrope-bold text-base text-text-primary dark:text-text-primary-dark">{invite.project_name}</Text>
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {invite.invited_by_name ?? 'Someone'} invited you as {roleLabel(invite.role)}
          </Text>
        </View>
      </View>
      {error && (
        <Text accessibilityRole="alert" className="font-manrope text-sm text-red-700 dark:text-red-400">
          Error: {error}
        </Text>
      )}
      <View className="flex-row gap-3">
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => respond(false)}
          className={`min-h-12 flex-1 items-center justify-center rounded-button border border-border dark:border-border-dark ${busy ? 'opacity-40' : 'active:opacity-70'}`}>
          <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Decline</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => respond(true)}
          className={`min-h-12 flex-1 items-center justify-center rounded-button bg-accent dark:bg-accent-dark ${busy ? 'opacity-40' : 'active:opacity-80'}`}>
          <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">Accept</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const label = [project.name, project.location, project.clientName && `Client ${project.clientName}`, roleLabel(project.role)]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Open members`}
      onPress={() => router.push({ pathname: '/project/[id]/members', params: { id: project.id } })}
      className="min-h-14 flex-row items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      <View className="flex-1 gap-1">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text className="flex-1 font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{project.name}</Text>
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{roleLabel(project.role)}</Text>
        </View>
        {project.location && (
          <Text numberOfLines={1} className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {project.location}
          </Text>
        )}
        {project.clientName && (
          <Text numberOfLines={1} className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            Client: {project.clientName}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export default function ProjectsTab() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { projects, loading, failed, reload } = useProjects();
  const { invites, reload: reloadInvites, respond } = useMyInvites();
  const [refreshing, setRefreshing] = useState(false);

  // One section per status, in PROJECT_STATUSES order; empty sections are left out.
  const sections = useMemo(
    () =>
      PROJECT_STATUSES.map(({ status, label }) => ({
        key: status,
        title: label,
        data: projects.filter((p) => p.status === status),
      })).filter((section) => section.data.length > 0),
    [projects],
  );

  useFocusEffect(
    useCallback(() => {
      reloadInvites();
    }, [reloadInvites]),
  );

  const onRespond = async (inviteId: string, accept: boolean) => {
    const failure = await respond(inviteId, accept);
    if (accept && !failure) await reload();
    return failure;
  };

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([reload(), reloadInvites()]);
    setRefreshing(false);
  };

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <SectionList
        sections={sections}
        keyExtractor={(project) => project.id}
        stickySectionHeadersEnabled={false}
        refreshing={refreshing}
        onRefresh={refresh}
        contentContainerClassName="gap-3 px-6 pb-28 pt-6"
        ListHeaderComponent={
          <View className="mb-1 gap-3">
            <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Projects</Text>
            {invites.length > 0 && (
              <View className="gap-3">
                <Text className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">Invitations</Text>
                {invites.map((invite) => (
                  <InviteCard key={invite.invite_id} invite={invite} onRespond={onRespond} />
                ))}
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={theme.accent} className="mt-8" />
          ) : (
            <Text className="mt-4 text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              {failed ? 'Could not load your projects. Pull down to try again.' : 'You are not on any projects yet.'}
            </Text>
          )
        }
        renderSectionHeader={({ section }) => (
          <Text
            accessibilityRole="header"
            className="mt-3 font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
            {section.title} · {section.data.length}
          </Text>
        )}
        renderItem={({ item }) => <ProjectRow project={item} />}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New project"
        onPress={() => router.push('/project/new')}
        className="absolute bottom-6 right-6 h-14 w-14 items-center justify-center rounded-full bg-accent active:opacity-80 dark:bg-accent-dark">
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={theme.textOnAccent} strokeWidth={2.2} strokeLinecap="round">
          <Path d="M12 5v14M5 12h14" />
        </Svg>
      </Pressable>
    </View>
  );
}

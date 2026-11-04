import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { useProjects, type ProjectSummary } from '@/hooks/use-projects';
import { PROJECT_STATUSES, roleLabel, type ProjectStatus } from '@/lib/projects';
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
      accessibilityLabel={`${label}. Open project`}
      onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })}
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

function SearchBar({ value, onChange, label }: { value: string; onChange: (text: string) => void; label: string }) {
  const theme = useTheme();
  return (
    <View className="min-h-12 flex-row items-center gap-2 rounded-button border border-border bg-surface px-3 dark:border-border-dark dark:bg-surface-dark">
      <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth={2} strokeLinecap="round">
        <Path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4" />
      </Svg>
      <TextInput
        accessibilityLabel={label}
        placeholder="Search by name or location"
        placeholderTextColor={theme.textSecondary}
        selectionColor={theme.accent}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        className="min-h-12 flex-1 font-manrope text-base text-text-primary dark:text-text-primary-dark"
      />
      {/* iOS has its own clear button; Android needs one. */}
      {value.length > 0 && Platform.OS === 'android' && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChange('')}
          hitSlop={8}
          className="h-11 w-11 items-center justify-center active:opacity-70">
          <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth={2.2} strokeLinecap="round">
            <Path d="M6 6l12 12M18 6L6 18" />
          </Svg>
        </Pressable>
      )}
    </View>
  );
}

const TABS = [...PROJECT_STATUSES.map(({ status, label }) => ({ key: status, label })), { key: 'pending', label: 'Pending' }] as const;
type TabKey = (typeof TABS)[number]['key'];

const matchesQuery = (project: ProjectSummary, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return project.name.toLowerCase().includes(q) || (project.location?.toLowerCase().includes(q) ?? false);
};

export default function ProjectsTab() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { projects, loading, failed, reload } = useProjects();
  const { invites, reload: reloadInvites, respond } = useMyInvites();
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>('ongoing');
  // Each tab keeps its own search text so switching tabs doesn't lose it.
  const [queries, setQueries] = useState<Record<ProjectStatus, string>>({ ongoing: '', closed: '' });
  const query = tab === 'pending' ? '' : queries[tab];
  const pendingCount = invites.length;

  const visibleProjects = useMemo(
    () => (tab === 'pending' ? [] : projects.filter((p) => p.status === tab && matchesQuery(p, query))),
    [projects, tab, query],
  );
  const tabLabel = (TABS.find((t) => t.key === tab)?.label ?? '').toLowerCase();

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

  const emptyText = () => {
    if (tab === 'pending') {
      return 'You have no pending invitations.';
    }
    if (failed) return 'Could not load your projects. Pull down to try again.';
    return query.trim() ? `No ${tabLabel} projects match "${query.trim()}".` : `You have no ${tabLabel} projects.`;
  };

  return (
    <View className="flex-1 bg-background dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <FlatList<ProjectSummary | MyInvite>
        data={tab === 'pending' ? invites : visibleProjects}
        keyExtractor={(item) => ('invite_id' in item ? item.invite_id : item.id)}
        refreshing={refreshing}
        onRefresh={refresh}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerClassName="gap-3 px-6 pb-28 pt-6"
        ListHeaderComponent={
          <View className="mb-1 gap-3">
            <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Projects</Text>

            <View accessibilityRole="tablist" className="flex-row border-b border-border dark:border-border-dark">
              {TABS.map(({ key, label }) => {
                const selected = tab === key;
                const badge = key === 'pending' && pendingCount > 0 ? pendingCount : null;
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    accessibilityLabel={
                      badge ? `${label}, ${badge} pending ${badge === 1 ? 'invitation' : 'invitations'}` : label
                    }
                    onPress={() => setTab(key)}
                    className="min-h-12 flex-1 flex-row items-center justify-center gap-1.5 active:opacity-70">
                    <Text
                      className={
                        selected
                          ? 'font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark'
                          : 'font-manrope-semibold text-base text-text-secondary dark:text-text-secondary-dark'
                      }>
                      {label}
                    </Text>
                    {/* Same badge as the Projects icon in the tab bar: a number, so the signal isn't colour alone. */}
                    {badge && (
                      <View className="h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 dark:bg-accent-dark">
                        <Text className="font-manrope-bold text-xs text-text-on-accent dark:text-text-on-accent-dark">{badge}</Text>
                      </View>
                    )}
                    {/* Accent marker on the selected tab, echoing the orange bar in the logo. */}
                    <View
                      className={`absolute bottom-0 h-0.5 w-full rounded-full ${selected ? 'bg-accent dark:bg-accent-dark' : 'bg-transparent'}`}
                    />
                  </Pressable>
                );
              })}
            </View>

            {tab !== 'pending' && (
              <SearchBar
                value={query}
                onChange={(text) => setQueries((prev) => ({ ...prev, [tab]: text }))}
                label={`Search ${tabLabel} projects`}
              />
            )}
          </View>
        }
        ListEmptyComponent={
          loading && tab !== 'pending' ? (
            <ActivityIndicator color={theme.accent} className="mt-8" />
          ) : (
            <Text className="mt-4 text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
              {emptyText()}
            </Text>
          )
        }
        renderItem={({ item }) =>
          'invite_id' in item ? <InviteCard invite={item} onRespond={onRespond} /> : <ProjectRow project={item} />
        }
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

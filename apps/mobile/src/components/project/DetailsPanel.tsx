import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';

import type { ProjectDetails } from '@/hooks/use-project';
import { PROJECT_STATUSES } from '@/lib/projects';
import { useTheme } from '@/theme/use-theme';

function Field({ label, value, last = false }: { label: string; value: string | null; last?: boolean }) {
  return (
    <View className={`gap-1 px-4 py-3 ${last ? '' : 'border-b border-border dark:border-border-dark'}`}>
      <Text className="font-manrope-semibold text-xs text-text-secondary dark:text-text-secondary-dark">{label}</Text>
      <Text
        selectable
        className={
          value
            ? 'font-manrope text-base text-text-primary dark:text-text-primary-dark'
            : 'font-manrope text-base text-text-secondary dark:text-text-secondary-dark'
        }>
        {value ?? 'Not set'}
      </Text>
    </View>
  );
}

type Props = {
  project: ProjectDetails | null;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
};

/** The Details tab of a project: name, status, location, client, type and description. */
export function DetailsPanel({ project, loading, failed, reload }: Props) {
  const theme = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  return (
    <ScrollView
      contentContainerClassName="gap-4 px-6 pb-10 pt-4"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.accent} colors={[theme.accent]} />}>
      {loading && !project ? (
        <ActivityIndicator color={theme.accent} className="mt-8" />
      ) : !project ? (
        <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          {failed ? 'Could not load this project. Pull down to try again.' : 'Project not found.'}
        </Text>
      ) : (
        <>
          <View className="overflow-hidden rounded-card border border-border bg-surface dark:border-border-dark dark:bg-surface-dark">
            <Field label="Project name" value={project.name} />
            <Field label="Status" value={PROJECT_STATUSES.find((s) => s.status === project.status)?.label ?? project.status} />
            <Field label="Location" value={project.location} />
            <Field label="Client" value={project.clientName} />
            <Field label="Type of project" value={project.projectType} last />
          </View>

          <View className="gap-2">
            <Text accessibilityRole="header" className="font-manrope-semibold text-sm text-text-secondary dark:text-text-secondary-dark">
              Description
            </Text>
            <View className="rounded-card border border-border bg-surface px-4 py-3 dark:border-border-dark dark:bg-surface-dark">
              <Text
                selectable
                className={
                  project.description
                    ? 'font-manrope text-base leading-6 text-text-primary dark:text-text-primary-dark'
                    : 'font-manrope text-base text-text-secondary dark:text-text-secondary-dark'
                }>
                {project.description ?? 'No description yet.'}
              </Text>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

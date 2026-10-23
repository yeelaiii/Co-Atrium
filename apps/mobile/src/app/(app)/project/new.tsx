import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { ChevronDown } from '@/components/ChevronDown';
import { OptionSheet } from '@/components/OptionSheet';
import { PROJECT_TYPES } from '@/lib/projects';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme/use-theme';

const inputClass =
  'min-h-[52px] rounded-button border border-border bg-surface px-4 font-manrope text-base text-text-primary focus:border-accent dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark dark:focus:border-accent-dark';

// Matches the projects table: name 1-120 chars; location 1-160; client 1-120; no control characters or angle brackets.
const clean = (value: string, max: number) => value.length <= max && !/[\p{Cc}<>]/u.test(value);

function Label({ text, optional = false, className = '' }: { text: string; optional?: boolean; className?: string }) {
  return (
    <Text className={`mb-2 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark ${className}`}>
      {text}
      {optional && <Text className="font-manrope text-text-secondary dark:text-text-secondary-dark"> (optional)</Text>}
    </Text>
  );
}

export default function NewProject() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [client, setClient] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectName = name.trim();
  const projectLocation = location.trim();
  const clientName = client.trim();
  const canCreate =
    projectName.length > 0 && clean(projectName, 120) && clean(projectLocation, 160) && clean(clientName, 120) && !saving;

  const create = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('create_project', {
      project_name: projectName,
      project_location: projectLocation || null,
      type_of_project: type,
      client: clientName || null,
    });
    if (rpcError) {
      setError(
        rpcError.code === '54000'
          ? 'You have reached the limit of 50 projects.'
          : rpcError.code === '23514'
            ? 'Check the details and try again. Some characters are not allowed.'
            : 'Could not create the project. Check your connection and try again.',
      );
      setSaving(false);
      return;
    }
    // The Projects tab refetches on focus, so the new project is there when we return.
    router.back();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background dark:bg-background-dark"
      style={{ paddingTop: insets.top }}>
      <ScrollView contentContainerClassName="px-6 pb-10 pt-4" keyboardShouldPersistTaps="handled">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={8}
          className="min-h-11 justify-center self-start active:opacity-70">
          <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">‹ Back</Text>
        </Pressable>

        <Text className="mb-6 font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">New project</Text>

        <Label text="Contract" optional />
        {/* Placeholder: picking and uploading a contract is not wired up yet. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Upload contract. Coming soon"
          accessibilityState={{ disabled: true }}
          className="min-h-24 items-center justify-center gap-1 rounded-card border border-dashed border-border bg-surface px-4 py-4 dark:border-border-dark dark:bg-surface-dark">
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" />
          </Svg>
          <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Upload contract</Text>
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Coming soon</Text>
        </Pressable>

        <Label text="Project name" className="mt-4" />
        <TextInput
          accessibilityLabel="Project name"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          maxLength={120}
          returnKeyType="next"
          className={inputClass}
        />

        <Label text="Location" optional className="mt-4" />
        <TextInput
          accessibilityLabel="Location"
          value={location}
          onChangeText={setLocation}
          autoCapitalize="words"
          autoComplete="street-address"
          textContentType="fullStreetAddress"
          maxLength={160}
          returnKeyType="next"
          className={inputClass}
        />

        <Label text="Project type" optional className="mt-4" />
        <Pressable
          accessibilityRole="combobox"
          accessibilityLabel="Project type"
          accessibilityValue={{ text: type ?? 'Not selected' }}
          onPress={() => setTypePickerOpen(true)}
          className="min-h-[52px] flex-row items-center justify-between rounded-button border border-border bg-surface px-4 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
          <Text
            className={`font-manrope text-base ${type ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
            {type ?? 'Select a type'}
          </Text>
          <ChevronDown />
        </Pressable>

        <Label text="Client" optional className="mt-4" />
        <TextInput
          accessibilityLabel="Client"
          value={client}
          onChangeText={setClient}
          autoCapitalize="words"
          autoComplete="organization"
          maxLength={120}
          returnKeyType="done"
          onSubmitEditing={create}
          className={inputClass}
        />

        {error && (
          <Text accessibilityRole="alert" className="mt-4 font-manrope text-sm text-red-700 dark:text-red-400">
            Error: {error}
          </Text>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canCreate, busy: saving }}
          disabled={!canCreate}
          onPress={create}
          className={`mt-6 min-h-12 items-center justify-center rounded-button bg-accent dark:bg-accent-dark ${canCreate ? 'active:opacity-80' : 'opacity-40'}`}>
          {saving ? (
            <ActivityIndicator color={theme.textOnAccent} />
          ) : (
            <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">Create project</Text>
          )}
        </Pressable>
      </ScrollView>

      <OptionSheet
        visible={typePickerOpen}
        title="Project type"
        options={PROJECT_TYPES}
        selected={type}
        onSelect={(next) => {
          setType(next);
          setTypePickerOpen(false);
        }}
        onClose={() => setTypePickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

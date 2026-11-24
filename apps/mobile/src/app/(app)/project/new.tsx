import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { ChevronDown } from '@/components/ChevronDown';
import { UploadProgress } from '@/components/contract/badges';
import { ContractFormPicker } from '@/components/contract/ContractFormPicker';
import { OptionSheet } from '@/components/OptionSheet';
import {
  type DeclaredForm,
  documentErrorMessage,
  formatBytes,
  pickDocuments,
  type PickedDocument,
  uploadContractDocument,
} from '@/lib/contract-documents';
import { PROJECT_TYPES } from '@/lib/projects';
import { invalidateQueries } from '@/lib/query-cache';
import { PROJECTS_KEY } from '@/hooks/use-projects';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme/use-theme';

const inputClass =
  'min-h-[52px] rounded-button border border-border bg-surface px-4 font-manrope text-base text-text-primary focus:border-accent dark:border-border-dark dark:bg-surface-dark dark:text-text-primary-dark dark:focus:border-accent-dark';

// Matches the projects table: name 1-120 chars; location 1-160; client 1-120; no control characters or angle brackets.
const clean = (value: string, max: number) => value.length <= max && !/[\p{Cc}<>]/u.test(value);
// Description (migration 0013) is the same but may span lines: tabs and line breaks are allowed.
const cleanMultiline = (value: string, max: number) => value.length <= max && !/[^\P{Cc}\t\n\r]|[<>]/u.test(value);

type ContractFile = { key: string; doc: PickedDocument; fraction: number; error: string | null; done: boolean };

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
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Contract: the form is chosen first, then the files; they upload once the project exists.
  const [contractForm, setContractForm] = useState<DeclaredForm | null | undefined>(undefined);
  const [files, setFiles] = useState<ContractFile[]>([]);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const seq = useRef(0);
  const created = projectId !== null;

  const projectName = name.trim();
  const projectLocation = location.trim();
  const clientName = client.trim();
  const projectDescription = description.trim();
  const canCreate =
    projectName.length > 0 &&
    clean(projectName, 120) &&
    clean(projectLocation, 160) &&
    clean(clientName, 120) &&
    cleanMultiline(projectDescription, 2000) &&
    (files.length === 0 || contractForm !== undefined) &&
    !saving;

  const patchFile = (key: string, p: Partial<ContractFile>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));

  const addFiles = async () => {
    setFileNotice(null);
    const { picked, rejected } = await pickDocuments();
    if (rejected.length) setFileNotice(rejected.join('\n'));
    setFiles((fs) => [
      ...fs,
      ...picked
        .filter((doc) => !fs.some((f) => f.doc.uri === doc.uri))
        .map((doc) => ({ key: `f${seq.current++}`, doc, fraction: 0, error: null, done: false })),
    ]);
  };

  const openContract = (pid: string) => router.replace({ pathname: '/project/[id]/contract/documents', params: { id: pid } });

  /** Uploads the files not yet uploaded, one at a time. True when all are up. */
  const uploadFiles = async (pid: string) => {
    let ok = true;
    for (const f of files) {
      if (f.done) continue;
      patchFile(f.key, { error: null, fraction: 0 });
      try {
        await uploadContractDocument(pid, f.doc, contractForm ?? null, (fraction) => patchFile(f.key, { fraction })).promise;
        patchFile(f.key, { done: true, fraction: 1 });
      } catch (e) {
        ok = false;
        patchFile(f.key, { error: documentErrorMessage(e) });
      }
    }
    return ok;
  };

  const create = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    if (created) {
      // The project exists: only the failed uploads are left.
      if (await uploadFiles(projectId)) openContract(projectId);
      else setSaving(false);
      return;
    }
    const { data: newId, error: rpcError } = await supabase.rpc('create_project', {
      project_name: projectName,
      project_location: projectLocation || null,
      type_of_project: type,
      client: clientName || null,
      project_description: projectDescription || null,
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
    // The Projects tab refetches when it regains focus, so the new project is there when we return.
    invalidateQueries(PROJECTS_KEY);
    const pid = newId as string;
    if (!files.length) {
      router.back();
      return;
    }
    setProjectId(pid);
    // Straight to the contract documents, where extraction progress shows; on a failed upload
    // stay here so it can be retried (the project is not created twice).
    if (await uploadFiles(pid)) openContract(pid);
    else {
      setError('The project was created, but some contract files did not upload.');
      setSaving(false);
    }
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
        <ContractFormPicker value={contractForm} onChange={setContractForm} disabled={saving || created} />
        <Text className="mb-3 mt-2 font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">
          Choose the form first. Values the contract doesn’t state are proposed from the form’s defaults, for you to check.
        </Text>
        {files.map((f) => (
          <View key={f.key} className="mb-2 gap-2 rounded-card border border-border bg-surface p-3 dark:border-border-dark dark:bg-surface-dark">
            <View className="flex-row items-center gap-2">
              <Text numberOfLines={1} className="flex-1 font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{f.doc.name}</Text>
              <Text className="font-manrope text-xs text-text-secondary dark:text-text-secondary-dark">{f.done ? 'Uploaded' : formatBytes(f.doc.size)}</Text>
              {!created && !saving && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${f.doc.name}`}
                  onPress={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                  hitSlop={8}
                  className="min-h-11 min-w-11 items-center justify-center active:opacity-70">
                  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth={2} strokeLinecap="round">
                    <Path d="M6 6l12 12M18 6L6 18" />
                  </Svg>
                </Pressable>
              )}
            </View>
            {saving && !f.done && !f.error && <UploadProgress fraction={f.fraction} label={`Uploading ${f.doc.name}`} />}
            {f.error && <Text className="font-manrope text-sm text-red-700 dark:text-red-400">Error: {f.error}</Text>}
          </View>
        ))}
        {!created && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={files.length ? 'Add more contract files' : 'Add contract files'}
            accessibilityHint={contractForm === undefined ? 'Choose the contract form first' : undefined}
            accessibilityState={{ disabled: contractForm === undefined || saving }}
            disabled={contractForm === undefined || saving}
            onPress={addFiles}
            className={`min-h-24 items-center justify-center gap-1 rounded-card border border-dashed border-border bg-surface px-4 py-4 dark:border-border-dark dark:bg-surface-dark ${contractForm === undefined || saving ? 'opacity-40' : 'active:opacity-70'}`}>
            <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" />
            </Svg>
            <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">{files.length ? 'Add more files' : 'Upload contract'}</Text>
            <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">PDF, Word or photos, up to 50 MB each</Text>
          </Pressable>
        )}
        {fileNotice && <Text className="mt-2 font-manrope text-sm text-amber-700 dark:text-amber-300">{fileNotice}</Text>}

        <Label text="Project name" className="mt-4" />
        <TextInput
          accessibilityLabel="Project name"
          editable={!created}
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
          editable={!created}
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
          disabled={created}
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
          editable={!created}
          value={client}
          onChangeText={setClient}
          autoCapitalize="words"
          autoComplete="organization"
          maxLength={120}
          returnKeyType="next"
          className={inputClass}
        />

        <Label text="Description" optional className="mt-4" />
        <TextInput
          accessibilityLabel="Description"
          editable={!created}
          value={description}
          onChangeText={setDescription}
          autoCapitalize="sentences"
          multiline
          textAlignVertical="top"
          maxLength={2000}
          className={inputClass.replace('min-h-[52px]', 'min-h-28 py-3')}
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
            <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">
              {created ? 'Try the upload again' : files.length ? 'Create project and upload' : 'Create project'}
            </Text>
          )}
        </Pressable>
        {created && !saving && (
          <Pressable
            accessibilityRole="button"
            onPress={() => openContract(projectId)}
            className="mt-2 min-h-12 items-center justify-center active:opacity-70">
            <Text className="font-manrope-semibold text-base text-accent dark:text-accent-dark">Continue without them</Text>
          </Pressable>
        )}
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

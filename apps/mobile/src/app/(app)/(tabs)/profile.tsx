import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OptionSheet } from '@/components/OptionSheet';
import { useProfile, type Profile as ProfileData } from '@/hooks/use-profile';
import { biometricsAvailable } from '@/lib/biometrics';
import { signOut } from '@/lib/google-auth';
import { ROLES } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';
import { useBiometricLock } from '@/providers/BiometricLockProvider';
import { useTheme } from '@/theme/use-theme';

const inputClass =
  'min-h-[52px] rounded-button border bg-surface px-4 font-manrope text-base text-text-primary dark:bg-surface-dark dark:text-text-primary-dark';

// Border colour is exclusive (never combined with the default) so NativeWind has one rule to apply.
const borderClass = (bad: boolean) =>
  bad ? 'border-red-700 dark:border-red-400' : 'border-border focus:border-accent dark:border-border-dark dark:focus:border-accent-dark';

// Label row; a "!" badge marks a field that is blank or invalid.
function FieldLabel({ label, bad, className = '' }: { label: string; bad: boolean; className?: string }) {
  return (
    <View className={`mb-2 flex-row items-center gap-2 ${className}`}>
      <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">{label}</Text>
      {bad && (
        <View
          accessible
          accessibilityLabel={`${label} is required`}
          className="h-5 w-5 items-center justify-center rounded-full bg-red-700 dark:bg-red-400">
          <Text className="font-manrope-bold text-xs text-white dark:text-text-on-accent-dark">!</Text>
        </View>
      )}
    </View>
  );
}

const SUCCESS_MESSAGE_MS = 5000;

// Matches the profiles table constraints: 1-80 chars, no control characters or angle brackets.
const valid = (value: string) => value.length > 0 && value.length <= 80 && !/[\p{Cc}<>]/u.test(value);

function ProfileForm({ profile, userId, reload }: { profile: ProfileData; userId: string; reload: () => Promise<void> }) {
  const theme = useTheme();
  const [displayName, setDisplayName] = useState(profile.display_name ?? '');
  const [company, setCompany] = useState(profile.company_name ?? '');
  const [role, setRole] = useState<string | null>(profile.job_role);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const name = displayName.trim();
  const companyName = company.trim();
  const dirty = name !== (profile.display_name ?? '') || companyName !== (profile.company_name ?? '') || role !== profile.job_role;
  const canSave = dirty && valid(name) && valid(companyName) && !!role && !saving;
  // Fields flagged with a "!" when blank or invalid.
  const nameBad = !valid(name);
  const companyBad = !valid(companyName);
  const roleBad = !role;

  // The success message clears itself; errors stay until the next save attempt.
  useEffect(() => {
    if (message?.kind !== 'success') return;
    const timer = setTimeout(() => setMessage(null), SUCCESS_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setMessage(null);
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: name, company_name: companyName, job_role: role })
      .eq('id', userId);
    if (error) {
      setMessage({ kind: 'error', text: 'Could not save your changes. Check your connection and try again.' });
    } else {
      await reload();
      setMessage({ kind: 'success', text: 'Changes saved.' });
    }
    setSaving(false);
  };

  return (
    <>
    <View>
      <FieldLabel label="Display name" bad={nameBad} />
      <TextInput
        accessibilityLabel="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        maxLength={80}
        returnKeyType="next"
        className={`${inputClass} ${borderClass(nameBad)}`}
      />

      <FieldLabel label="Company" bad={companyBad} className="mt-4" />
      <TextInput
        accessibilityLabel="Company"
        value={company}
        onChangeText={setCompany}
        autoCapitalize="words"
        autoComplete="organization"
        textContentType="organizationName"
        maxLength={80}
        returnKeyType="done"
        className={`${inputClass} ${borderClass(companyBad)}`}
      />

      <FieldLabel label="Role" bad={roleBad} className="mt-4" />
      <Pressable
        accessibilityRole="combobox"
        accessibilityLabel="Role"
        accessibilityValue={{ text: role ?? 'Not selected' }}
        onPress={() => setRolePickerOpen(true)}
        className={`min-h-[52px] flex-row items-center justify-between rounded-button border bg-surface px-4 active:opacity-70 dark:bg-surface-dark ${roleBad ? 'border-red-700 dark:border-red-400' : 'border-border dark:border-border-dark'}`}>
        <Text
          className={`font-manrope text-base ${role ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
          {role ?? 'Select your role'}
        </Text>
        <Text className="font-manrope-bold text-base text-text-secondary dark:text-text-secondary-dark">⌄</Text>
      </Pressable>

      {message && (
        <Text
          accessibilityRole="alert"
          className={`mt-4 font-manrope text-sm ${message.kind === 'error' ? 'text-red-700 dark:text-red-400' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
          {message.kind === 'error' ? 'Error: ' : '✓ '}
          {message.text}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSave, busy: saving }}
        disabled={!canSave}
        onPress={save}
        className={`mt-6 min-h-12 items-center justify-center rounded-button bg-accent dark:bg-accent-dark ${canSave ? 'active:opacity-80' : 'opacity-40'}`}>
        {saving ? (
          <ActivityIndicator color={theme.textOnAccent} />
        ) : (
          <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">
            Save changes
          </Text>
        )}
      </Pressable>
    </View>
    <OptionSheet
      visible={rolePickerOpen}
      title="Select your role"
      options={ROLES}
      selected={role}
      onSelect={(next) => {
        setRole(next);
        setRolePickerOpen(false);
      }}
      onClose={() => setRolePickerOpen(false)}
    />
    </>
  );
}

export default function Profile() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const { profile, loading, reload } = useProfile();
  const lock = useBiometricLock();

  const [canUseBiometrics, setCanUseBiometrics] = useState(false);

  useEffect(() => {
    biometricsAvailable().then(setCanUseBiometrics);
  }, []);

  const toggleBiometrics = async (value: boolean) => {
    if (value) await lock.enable();
    else await lock.disable();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background dark:bg-background-dark">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: 32, paddingHorizontal: 24, gap: 24 }}>
        <View className="gap-1">
          <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Profile</Text>
          <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
            {session?.user.email}
          </Text>
        </View>

        {loading || !profile || !session ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <ProfileForm profile={profile} userId={session.user.id} reload={reload} />
        )}

        {canUseBiometrics && (
          <View className="min-h-12 flex-row items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-2 dark:border-border-dark dark:bg-surface-dark">
            <View className="flex-1">
              <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">
                Unlock with biometrics
              </Text>
              <Text className="font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
                Ask for Face ID or fingerprint when opening the app.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Unlock with biometrics"
              value={lock.enabled}
              onValueChange={toggleBiometrics}
              trackColor={{ true: theme.accent }}
            />
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          onPress={signOut}
          className="min-h-12 items-center justify-center rounded-button border border-border active:opacity-70 dark:border-border-dark">
          <Text className="font-manrope-semibold text-base text-text-primary dark:text-text-primary-dark">Sign out</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

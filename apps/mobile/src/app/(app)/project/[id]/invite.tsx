import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronDown } from '@/components/ChevronDown';
import { OptionSheet } from '@/components/OptionSheet';
import { INVITE_ROLES, inviteErrorMessage, isEmail, type InviteRole } from '@/lib/projects';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme/use-theme';

export default function InvitePerson() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const address = email.trim().toLowerCase();
  const emailBad = email.length > 0 && !isEmail(address);
  const canSend = isEmail(address) && !sending;
  const selected = INVITE_ROLES.find((r) => r.role === role)!;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setMessage(null);
    const { error } = await supabase.rpc('invite_project_member_by_email', {
      pid: id,
      invitee_email: address,
      member_role: role,
    });
    if (error) {
      setMessage({ kind: 'error', text: inviteErrorMessage(error) });
    } else {
      // Same wording whether or not the address has an account, so owners can't probe for users.
      setMessage({ kind: 'success', text: `Invite sent to ${address}. They can accept it in the app.` });
      setEmail('');
    }
    setSending(false);
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

        <Text className="mb-1 font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Add person</Text>
        <Text className="mb-6 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">
          Enter the email they use for Co-Atrium. If they have no account yet, the invite will be waiting when they sign up.
        </Text>

        <View className="mb-2 flex-row items-center gap-2">
          <Text className="font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Email</Text>
          {emailBad && (
            <View accessible accessibilityLabel="Email is not valid" className="h-5 w-5 items-center justify-center rounded-full bg-red-700 dark:bg-red-400">
              <Text className="font-manrope-bold text-xs text-white dark:text-text-on-accent-dark">!</Text>
            </View>
          )}
        </View>
        <TextInput
          accessibilityLabel="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          maxLength={254}
          returnKeyType="send"
          onSubmitEditing={send}
          className={`min-h-[52px] rounded-button border bg-surface px-4 font-manrope text-base text-text-primary dark:bg-surface-dark dark:text-text-primary-dark ${emailBad ? 'border-red-700 dark:border-red-400' : 'border-border focus:border-accent dark:border-border-dark dark:focus:border-accent-dark'}`}
        />

        <Text className="mb-2 mt-4 font-manrope-semibold text-sm text-text-primary dark:text-text-primary-dark">Access</Text>
        <Pressable
          accessibilityRole="combobox"
          accessibilityLabel="Access"
          accessibilityValue={{ text: selected.label }}
          onPress={() => setPickerOpen(true)}
          className="min-h-[52px] flex-row items-center justify-between rounded-button border border-border bg-surface px-4 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
          <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">{selected.label}</Text>
          <ChevronDown />
        </Pressable>
        <Text className="mt-2 font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">{selected.description}</Text>

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
          accessibilityState={{ disabled: !canSend, busy: sending }}
          disabled={!canSend}
          onPress={send}
          className={`mt-6 min-h-12 items-center justify-center rounded-button bg-accent dark:bg-accent-dark ${canSend ? 'active:opacity-80' : 'opacity-40'}`}>
          {sending ? (
            <ActivityIndicator color={theme.textOnAccent} />
          ) : (
            <Text className="font-manrope-semibold text-base text-text-on-accent dark:text-text-on-accent-dark">Send invite</Text>
          )}
        </Pressable>
      </ScrollView>

      <OptionSheet
        visible={pickerOpen}
        title="Access level"
        options={INVITE_ROLES.map((r) => r.label)}
        selected={selected.label}
        onSelect={(label) => {
          setRole(INVITE_ROLES.find((r) => r.label === label)!.role);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

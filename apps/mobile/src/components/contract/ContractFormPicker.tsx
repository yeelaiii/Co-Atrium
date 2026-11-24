import { useState } from 'react';
import { Pressable, Text } from 'react-native';

import { ChevronDown } from '@/components/ChevronDown';
import { OptionSheet } from '@/components/OptionSheet';
import {
  DECLARED_FORM_OPTIONS,
  type DeclaredForm,
  declaredFormFromLabel,
  declaredFormLabel,
} from '@/lib/contract-documents';

/**
 * The contract form the uploader says the documents use, chosen before uploading.
 * `value` undefined = nothing chosen yet; null = "not sure" (extraction identifies it).
 * The form's own periods fill in values the document doesn't state.
 */
export function ContractFormPicker({
  value,
  onChange,
  disabled,
}: {
  value: DeclaredForm | null | undefined;
  onChange: (form: DeclaredForm | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chosen = value !== undefined;
  const label = chosen ? declaredFormLabel(value) : 'Select the contract form';

  return (
    <>
      <Pressable
        accessibilityRole="combobox"
        accessibilityLabel="Contract form"
        accessibilityValue={{ text: chosen ? label : 'Not selected' }}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        className={`min-h-[52px] flex-row items-center justify-between gap-2 rounded-button border border-border bg-surface px-4 dark:border-border-dark dark:bg-surface-dark ${disabled ? 'opacity-40' : 'active:opacity-70'}`}>
        <Text
          numberOfLines={2}
          className={`flex-1 font-manrope text-base ${chosen ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark'}`}>
          {label}
        </Text>
        <ChevronDown />
      </Pressable>
      <OptionSheet
        visible={open}
        title="Which contract form is this?"
        options={DECLARED_FORM_OPTIONS}
        selected={chosen ? label : null}
        onSelect={(option) => {
          onChange(declaredFormFromLabel(option));
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

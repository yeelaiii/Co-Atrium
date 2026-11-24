import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { Platform, Pressable, Text, View, useColorScheme } from 'react-native';

import { useTheme } from '@/theme/use-theme';

type Props = {
  value: Date;
  onChange: (d: Date) => void;
  /** 'datetime' picks a date and a time; 'date' only a date. */
  mode?: 'date' | 'datetime';
  maximumDate?: Date;
  accessibilityLabel: string;
};

const SGT = 'Asia/Singapore';
const fmtDate = (d: Date) => d.toLocaleDateString('en-SG', { timeZone: SGT, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: Date) => d.toLocaleTimeString('en-SG', { timeZone: SGT, hour: '2-digit', minute: '2-digit' });

/**
 * Date (and time) picker. iOS shows the native compact picker inline; Android opens a date
 * dialog and then, for 'datetime', a separate time dialog (Android has no combined picker).
 * Times are shown in Singapore time, which is what deadlines run on.
 */
export function DateTimeField({ value, onChange, mode = 'datetime', maximumDate, accessibilityLabel }: Props) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const [open, setOpen] = useState<'date' | 'time' | null>(null);

  if (Platform.OS === 'ios') {
    return (
      <View accessibilityLabel={accessibilityLabel} className="min-h-[52px] flex-row items-center">
        <DateTimePicker
          value={value}
          mode={mode}
          display="compact"
          maximumDate={maximumDate}
          timeZoneName={SGT}
          locale="en_SG"
          themeVariant={scheme === 'dark' ? 'dark' : 'light'}
          accentColor={theme.accent}
          onValueChange={(_e, d) => onChange(d)}
        />
      </View>
    );
  }

  const button = (which: 'date' | 'time', text: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${which}, ${text}. Change`}
      onPress={() => setOpen(which)}
      className="min-h-[52px] flex-1 justify-center rounded-button border border-border bg-surface px-4 active:opacity-70 dark:border-border-dark dark:bg-surface-dark">
      <Text className="font-manrope text-base text-text-primary dark:text-text-primary-dark">{text}</Text>
    </Pressable>
  );

  return (
    <View className="flex-row gap-2">
      {button('date', fmtDate(value))}
      {mode === 'datetime' && button('time', fmtTime(value))}
      {open && (
        <DateTimePicker
          value={value}
          mode={open}
          presentation="dialog"
          maximumDate={open === 'date' ? maximumDate : undefined}
          accentColor={theme.accent}
          onValueChange={(_e, d) => {
            setOpen(null);
            if (open === 'date') {
              // Keep the time of day when only the date changes.
              const next = new Date(d);
              next.setHours(value.getHours(), value.getMinutes(), 0, 0);
              onChange(next);
            } else {
              onChange(d);
            }
          }}
          onDismiss={() => setOpen(null)}
        />
      )}
    </View>
  );
}

import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = {
  visible: boolean;
  title: string;
  options: readonly string[];
  selected: string | null;
  onSelect: (option: string) => void;
  onClose: () => void;
};

// Bottom sheet used as a dropdown list; the selected row carries the accent marker.
export function OptionSheet({ visible, title, options, selected, onSelect, onClose }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable accessibilityLabel="Close" onPress={onClose} className="flex-1 justify-end bg-black/50">
        <Pressable
          onPress={() => {}}
          className="max-h-[70%] rounded-t-card border border-border bg-surface dark:border-border-dark dark:bg-surface-dark"
          style={{ paddingBottom: insets.bottom + 8 }}>
          <Text className="px-6 pb-2 pt-5 font-manrope-bold text-lg text-text-primary dark:text-text-primary-dark">
            {title}
          </Text>
          <ScrollView>
            {options.map((option) => {
              const active = option === selected;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => onSelect(option)}
                  className="min-h-14 flex-row items-center gap-3 px-6 active:opacity-70">
                  <View className={`h-6 w-1.5 rounded-full ${active ? 'bg-accent dark:bg-accent-dark' : 'bg-transparent'}`} />
                  <Text
                    className={`flex-1 text-base text-text-primary dark:text-text-primary-dark ${active ? 'font-manrope-bold' : 'font-manrope'}`}>
                    {option}
                  </Text>
                  {active && (
                    <Text className="font-manrope-semibold text-sm text-accent dark:text-accent-dark">Selected</Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

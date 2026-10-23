import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Placeholder tab: real content comes later.
export default function SearchTab() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 items-center justify-center gap-1.5 bg-background px-6 dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Search</Text>
      <Text className="text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Search your records here.</Text>
    </View>
  );
}

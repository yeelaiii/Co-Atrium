import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Placeholder tab: real content comes later.
export default function ProjectsTab() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 items-center justify-center gap-1.5 bg-background px-6 dark:bg-background-dark" style={{ paddingTop: insets.top }}>
      <Text className="font-manrope-bold text-2xl text-text-primary dark:text-text-primary-dark">Projects</Text>
      <Text className="text-center font-manrope text-sm text-text-secondary dark:text-text-secondary-dark">Your projects will appear here.</Text>
    </View>
  );
}

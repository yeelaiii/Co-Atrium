import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/Logo';
import { NotificationPrompt } from '@/components/NotificationPrompt';

// Shown instead of the app whenever notification permission is off.
export default function NotificationsRequired() {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <View className="px-6" style={{ paddingTop: insets.top + 24 }}>
        <LogoMark width={44} />
      </View>
      <NotificationPrompt />
    </View>
  );
}

import { Tabs } from 'expo-router';

import { TabIcon, type TabIconName } from '@/components/TabIcon';
import { useTheme } from '@/theme/use-theme';

const TABS: { name: string; title: string; icon: TabIconName }[] = [
  { name: 'index', title: 'Home', icon: 'home' },
  { name: 'search', title: 'Search', icon: 'search' },
  { name: 'projects', title: 'Projects', icon: 'folder' },
  { name: 'profile', title: 'Profile', icon: 'profile' },
];

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarLabelStyle: { fontFamily: 'Manrope_600SemiBold', fontSize: 12 },
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border, borderTopWidth: 1 },
      }}>
      {TABS.map(({ name, title, icon }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{ title, tabBarIcon: ({ color }) => <TabIcon name={icon} color={color} /> }}
        />
      ))}
    </Tabs>
  );
}

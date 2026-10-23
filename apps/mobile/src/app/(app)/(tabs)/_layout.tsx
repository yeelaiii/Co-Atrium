import { Tabs } from 'expo-router';

import { TabIcon, type TabIconName } from '@/components/TabIcon';
import { InvitesProvider, useMyInvites } from '@/providers/InvitesProvider';
import { useTheme } from '@/theme/use-theme';

const TABS: { name: string; title: string; icon: TabIconName }[] = [
  { name: 'index', title: 'Home', icon: 'home' },
  { name: 'search', title: 'Search', icon: 'search' },
  { name: 'projects', title: 'Projects', icon: 'folder' },
  { name: 'profile', title: 'Settings', icon: 'settings' },
];

function TabBar() {
  const theme = useTheme();
  const { invites } = useMyInvites();
  const pending = invites.length;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarLabelStyle: { fontFamily: 'Manrope_600SemiBold', fontSize: 12 },
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border, borderTopWidth: 1 },
        tabBarBadgeStyle: {
          backgroundColor: theme.accent,
          color: theme.textOnAccent,
          fontFamily: 'Manrope_700Bold',
          fontSize: 12,
        },
      }}>
      {TABS.map(({ name, title, icon }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarIcon: ({ color }) => <TabIcon name={icon} color={color} />,
            // A count (not just a dot) so the signal isn't colour alone; Projects is where invitations are answered.
            ...(name === 'projects' && {
              tabBarBadge: pending > 0 ? pending : undefined,
              tabBarAccessibilityLabel: pending > 0 ? `Projects, ${pending} pending ${pending === 1 ? 'invitation' : 'invitations'}` : 'Projects',
            }),
          }}
        />
      ))}
    </Tabs>
  );
}

export default function TabsLayout() {
  return (
    <InvitesProvider>
      <TabBar />
    </InvitesProvider>
  );
}

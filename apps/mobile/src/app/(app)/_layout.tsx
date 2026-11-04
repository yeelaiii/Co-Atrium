import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { useEffect, useRef } from 'react';

import { registerForPushNotifications, voNotificationData, watchPushToken } from '@/lib/push';
import { useAuth } from '@/providers/AuthProvider';

// Show VO notifications as banners even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** Registers this device for push and opens the right VO when a notification is tapped. */
function usePushNotifications() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    registerForPushNotifications();
    const sub = watchPushToken();
    return () => sub.remove();
  }, [userId]);

  useEffect(() => {
    if (!lastResponse || lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const key = lastResponse.notification.request.identifier;
    if (handled.current === key) return;
    handled.current = key;
    Notifications.clearLastNotificationResponse();

    const data = voNotificationData(lastResponse);
    if (!data) return;
    if (data.type === 'vo_approval_request' || data.type === 'vo_shared') {
      // Asked to approve, or included: open triage on that VO, photo first (with Approve if asked).
      router.push({ pathname: '/project/[id]', params: { id: data.projectId, vo: data.variationOrderId } });
    } else {
      // Someone approved your VO: the approval log line is in the thread.
      router.push({ pathname: '/project/[id]/vo/[voId]', params: { id: data.projectId, voId: data.variationOrderId } });
    }
  }, [lastResponse]);
}

export default function AppLayout() {
  usePushNotifications();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

// The token this device registered for the signed-in user, so sign-out can remove it.
let registeredToken: string | null = null;

async function save(token: string) {
  const { error } = await supabase.rpc('register_push_token', { push_token: token, device_platform: Platform.OS });
  if (!error) registeredToken = token;
}

/**
 * Registers this device's Expo push token for the signed-in user so they are notified when
 * a VO needs their approval (sent from the database, migration 0016). Needs a development or
 * store build on a physical device; returns quietly otherwise.
 */
export async function registerForPushNotifications() {
  if (!Device.isDevice || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return;
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.ios?.status !== IosAuthorizationStatus.PROVISIONAL) return;
  // Android needs the channel before a token; the server sends on 'default'.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Default', importance: AndroidImportance.MAX });
  }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await save(data);
  } catch (e) {
    console.warn('Push registration failed', e);
  }
}

/** Expo tokens can rotate; keep the server's copy current. */
export function watchPushToken() {
  return Notifications.addPushTokenListener(() => {
    registerForPushNotifications();
  });
}

/** Call before signing out, while the session is still valid. */
export async function unregisterPushNotifications() {
  if (!registeredToken) return;
  const token = registeredToken;
  registeredToken = null;
  await supabase.rpc('unregister_push_token', { push_token: token });
}

export type VoNotificationData = { type: 'vo_approval_request' | 'vo_shared' | 'vo_approved'; projectId: string; variationOrderId: string };

export function voNotificationData(response: Notifications.NotificationResponse | null | undefined): VoNotificationData | null {
  const data = response?.notification.request.content.data as Partial<VoNotificationData> | undefined;
  if (!data || typeof data.projectId !== 'string' || typeof data.variationOrderId !== 'string') return null;
  if (data.type !== 'vo_approval_request' && data.type !== 'vo_shared' && data.type !== 'vo_approved') return null;
  return data as VoNotificationData;
}

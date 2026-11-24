import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus, type DevicePushToken } from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

// The Expo token saved on the server for the signed-in user, so sign-out can remove it and
// repeat calls can skip the RPC.
let registered: { userId: string; token: string } | null = null;
// The last native (APNs/FCM) token we built an Expo token from.
let lastDeviceToken: string | null = null;
// One registration at a time; concurrent callers share it.
let inFlight: Promise<void> | null = null;

async function register(userId: string, devicePushToken?: DevicePushToken) {
  if (!Device.isDevice || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return;
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.ios?.status !== IosAuthorizationStatus.PROVISIONAL) return;
  // Android needs the channel before a token; the server sends on 'default'.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Default', importance: AndroidImportance.MAX });
  }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  try {
    // On iOS, asking for the device token also fires the push-token event (see watchPushToken),
    // so the token is recorded here before any listener compares against it.
    const device = devicePushToken ?? (await Notifications.getDevicePushTokenAsync());
    lastDeviceToken = String(device.data);
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId, devicePushToken: device });
    if (registered?.userId === userId && registered.token === token) return;
    const { error } = await supabase.rpc('register_push_token', { push_token: token, device_platform: Platform.OS });
    if (!error) registered = { userId, token };
  } catch (e) {
    console.warn('Push registration failed', e);
  }
}

/**
 * Registers this device's Expo push token for the signed-in user so they are notified when
 * a VO needs their approval (sent from the database, migration 0016). Needs a development or
 * store build on a physical device; returns quietly otherwise. Calls the server only when the
 * token or user changed since the last successful registration.
 */
export function registerForPushNotifications(userId: string, devicePushToken?: DevicePushToken): Promise<void> {
  if (!inFlight) {
    inFlight = register(userId, devicePushToken).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * Expo tokens can rotate; keep the server's copy current. iOS emits this event on every
 * getDevicePushTokenAsync call (including our own), so only a token we have not seen, arriving
 * outside a registration, triggers another one. Without this check the two call each other
 * forever and spam register_push_token.
 */
export function watchPushToken(userId: string) {
  return Notifications.addPushTokenListener((token) => {
    if (inFlight || String(token.data) === lastDeviceToken) return;
    registerForPushNotifications(userId, token);
  });
}

/** Call before signing out, while the session is still valid. */
export async function unregisterPushNotifications() {
  if (!registered) return;
  const { token } = registered;
  registered = null;
  await supabase.rpc('unregister_push_token', { push_token: token });
}

export type VoNotificationData = { type: 'vo_approval_request' | 'vo_shared' | 'vo_approved'; projectId: string; variationOrderId: string };

export function voNotificationData(response: Notifications.NotificationResponse | null | undefined): VoNotificationData | null {
  const data = response?.notification.request.content.data as Partial<VoNotificationData> | undefined;
  if (!data || typeof data.projectId !== 'string' || typeof data.variationOrderId !== 'string') return null;
  if (data.type !== 'vo_approval_request' && data.type !== 'vo_shared' && data.type !== 'vo_approved') return null;
  return data as VoNotificationData;
}

export type ObligationNotificationData = { type: 'obligation_reminder'; projectId: string; obligationId: string };

/** Deadline reminders (sent by the send-reminders Edge Function). */
export function obligationNotificationData(response: Notifications.NotificationResponse | null | undefined): ObligationNotificationData | null {
  const data = response?.notification.request.content.data as Partial<ObligationNotificationData> | undefined;
  if (!data || data.type !== 'obligation_reminder' || typeof data.projectId !== 'string' || typeof data.obligationId !== 'string') return null;
  return data as ObligationNotificationData;
}

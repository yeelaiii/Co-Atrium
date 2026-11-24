// Reminder delivery channels. Add email later by implementing ReminderChannel.

import type { Db } from './http.ts';

export interface Delivery {
  userId: string;
  projectId: string;
  obligationId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface ReminderChannel {
  /** Stored in reminders_sent.channel. */
  id: 'push' | 'in_app';
  deliver(db: Db, items: Delivery[]): Promise<void>;
}

export const inAppChannel: ReminderChannel = {
  id: 'in_app',
  async deliver(db, items) {
    if (!items.length) return;
    const { error } = await db.from('notifications').insert(
      items.map((d) => ({
        user_id: d.userId,
        project_id: d.projectId,
        obligation_id: d.obligationId,
        kind: 'obligation_reminder',
        title: d.title,
        body: d.body,
        data: d.data,
      })),
    );
    if (error) throw error;
  },
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Expo push. Tickets with DeviceNotRegistered delete that token. Receipts (delivery
 * confirmations fetched later) are not polled yet; see docs/contracts-plan.md limitations.
 */
export function expoPushChannel(fetchFn: typeof fetch = fetch): ReminderChannel {
  return {
    id: 'push',
    async deliver(db, items) {
      if (!items.length) return;
      const userIds = [...new Set(items.map((i) => i.userId))];
      const { data: tokens, error } = await db.from('push_tokens').select('token, user_id').in('user_id', userIds);
      if (error) throw error;
      const messages: { to: string; title: string; body: string; data: Record<string, unknown> }[] = [];
      for (const item of items) {
        for (const t of (tokens ?? []).filter((x: { user_id: string }) => x.user_id === item.userId)) {
          messages.push({ to: t.token, title: item.title, body: item.body, data: item.data });
        }
      }
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        const res = await fetchFn(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(chunk.map((m) => ({ ...m, sound: 'default', channelId: 'default', priority: 'high' }))),
        });
        if (!res.ok) {
          console.warn(`Expo push failed: HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { data?: ExpoTicket[] };
        const dead = (body.data ?? [])
          .map((t, idx) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? chunk[idx].to : null))
          .filter((x): x is string => !!x);
        if (dead.length) await db.from('push_tokens').delete().in('token', dead);
      }
    },
  };
}

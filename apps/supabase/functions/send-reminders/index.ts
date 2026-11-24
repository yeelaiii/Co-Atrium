// send-reminders: run by pg_cron every 15 minutes (migration 0021) with the secret API key.
//   1. drain obligation_queue (events logged while the app was offline, recalculations);
//   2. mark passed obligations overdue (actions) or met (milestones) and suggest chains_to follow-ons;
//   3. send the reminders that are due, at most once each (reminders_sent).
// Never sends contractual notices: reminders are for the app's users only.

import { markDue, processQueue, sendReminders } from '../_shared/server/engine.ts';
import { handle, HttpError, isServiceCall, json, serviceClient } from '../_shared/server/http.ts';

Deno.serve(handle(async (req) => {
  if (!isServiceCall(req)) throw new HttpError(403, 'Secret key only');
  const db = serviceClient();
  const now = new Date();
  const queue = await processQueue(db, { limit: 200, now });
  const due = await markDue(db, now);
  const reminders = await sendReminders(db, now);
  return json({ queue: queue.processed, due, reminders: reminders.sent });
}));

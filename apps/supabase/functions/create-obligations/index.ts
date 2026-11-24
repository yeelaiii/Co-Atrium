// create-obligations: turns newly logged events into obligations.
//
// Called by the app right after log_project_event() with the user's JWT and { project_id }
// (fast path), and by send-reminders every 15 minutes with the secret key (safety net that
// drains the whole obligation_queue). Idempotent: obligations are unique per rule group + event.

import { processQueue } from '../_shared/server/engine.ts';
import { handle, HttpError, isServiceCall, json, requireProjectStaff, serviceClient } from '../_shared/server/http.ts';

Deno.serve(handle(async (req) => {
  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.project_id === 'string' ? body.project_id : undefined;
  if (isServiceCall(req)) return json(await processQueue(serviceClient(), { projectId, limit: 200 }));
  if (!projectId) throw new HttpError(400, 'project_id is required');
  await requireProjectStaff(req, projectId);
  return json(await processQueue(serviceClient(), { projectId }));
}));

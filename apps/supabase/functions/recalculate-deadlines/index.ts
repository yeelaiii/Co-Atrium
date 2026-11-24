// recalculate-deadlines: recomputes every obligation of a project from its events, verified rules
// and confirmed fields. Run after the completion date changes (EOT granted, VO time agreed),
// a rule is verified or edited, or deadline settings change. Open obligations move; met and
// waived ones are left alone. Returns whether deadlines are live and which required fields are missing.

import { recalculateProject } from '../_shared/server/engine.ts';
import { handle, HttpError, isServiceCall, json, requireProjectStaff, serviceClient } from '../_shared/server/http.ts';

Deno.serve(handle(async (req) => {
  const body = await req.json().catch(() => ({}));
  if (typeof body.project_id !== 'string') throw new HttpError(400, 'project_id is required');
  if (!isServiceCall(req)) await requireProjectStaff(req, body.project_id);
  const db = serviceClient();
  const result = await recalculateProject(db, body.project_id);
  // Any queued work for this project is now done.
  await db.from('obligation_queue').update({ processed_at: new Date().toISOString() })
    .eq('project_id', body.project_id).is('processed_at', null);
  return json(result);
}));

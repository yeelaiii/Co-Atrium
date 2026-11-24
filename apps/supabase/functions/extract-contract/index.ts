// extract-contract: runs the contract extraction pipeline (_shared/server/extraction.ts).
//
// Called with { document_id }:
//   * by register_contract_document() through pg_net (secret key),
//   * by the app right after registering an upload (the user's JWT; must be owner/member),
// and with {} by pg_cron every minute (secret key), which resumes any job that is due.
// Each invocation works for at most ~110 s, saving progress after every step, so long
// documents never time out a single run. Idempotent: jobs are claimed with a lease.

import { runExtraction } from '../_shared/server/extraction-io.ts';
import { handle, HttpError, isServiceCall, json, requireProjectStaff, serviceClient } from '../_shared/server/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

Deno.serve(handle(async (req) => {
  const body = await req.json().catch(() => ({}));
  const documentId = typeof body.document_id === 'string' && UUID.test(body.document_id) ? body.document_id : undefined;
  const db = serviceClient();

  if (!isServiceCall(req)) {
    if (!documentId) throw new HttpError(400, 'document_id is required');
    const { data: doc } = await db.from('contract_documents').select('project_id').eq('id', documentId).maybeSingle();
    if (!doc) throw new HttpError(404, 'Document not found');
    await requireProjectStaff(req, doc.project_id);
  }
  return json(await runExtraction(db, { documentId }));
}));

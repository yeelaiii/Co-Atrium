// ExtractionIO backed by Supabase (service role), plus the job runner used by extract-contract:
// claim a job, run it within a time budget, record the outcome, and re-kick when work remains.

import { aiConfig } from '../llm/ai-config.ts';
import type { AiConfig } from '../llm/config-schema.ts';
import { LlmError, ResidencyError } from '../llm/provider.ts';
import { createRouter } from '../llm/router.ts';
import { paddleOcrProvider } from '../ocr/paddleocr.ts';
import type { OcrProvider } from '../ocr/provider.ts';
import {
  type DocumentInfo,
  type ExtractionIO,
  FatalExtractionError,
  isFatal,
  type Job,
  type PageRow,
  type RuleRow,
  runJob,
} from './extraction.ts';
import type { Db } from './http.ts';

function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data;
}

export function supabaseExtractionIO(db: Db): ExtractionIO {
  return {
    async document(id) {
      const d = check(
        await db.from('contract_documents').select('id, project_id, storage_path, mime, filename').eq('id', id)
          .single(),
      );
      return d as DocumentInfo;
    },
    async download(path) {
      const { data, error } = await db.storage.from('contract-documents').download(path);
      if (error || !data) throw new Error(`Download failed: ${error?.message ?? 'no data'}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async pages(documentId) {
      const rows = check(
        await db.from('document_pages').select(
          'page_no, text, text_source, needs_ocr, section, section_source, ocr_provider, ocr_confidence',
        )
          .eq('document_id', documentId).order('page_no'),
      );
      return (rows ?? []) as PageRow[];
    },
    async upsertPages(doc, rows) {
      for (let i = 0; i < rows.length; i += 200) {
        check(
          await db.from('document_pages').upsert(
            rows.slice(i, i + 200).map((r) => ({ ...r, document_id: doc.id, project_id: doc.project_id })),
            { onConflict: 'document_id,page_no' },
          ),
        );
      }
    },
    async setDocument(id, patch) {
      check(await db.from('contract_documents').update(patch).eq('id', id));
    },
    async saveCursor(job) {
      check(
        await db.from('extraction_jobs').update({ step: job.step, cursor: job.cursor }).eq(
          'document_id',
          job.document_id,
        ),
      );
    },
    async reserveOcr(provider, day, wanted, quota) {
      return check(await db.rpc('reserve_ocr_pages', { p_provider: provider, p_day: day, wanted, quota })) as number;
    },
    async projectRules(projectId) {
      return (check(await db.from('deadline_rules').select('*').eq('project_id', projectId)) ?? []) as RuleRow[];
    },
    async writeResults(doc, out) {
      check(
        await db.rpc('write_extraction_results', {
          did: doc.id,
          fields: out.fields,
          rules: out.rules,
          findings: out.findings,
        }),
      );
      check(await db.from('contract_documents').update({ warnings: out.warnings }).eq('id', doc.id));
    },
  };
}

/** The OCR provider, or null when it is off or its region isn't allowed. */
export function ocrFromConfig(config: AiConfig, secret: (n: string) => string | undefined): OcrProvider | null {
  const o = config.ocr;
  if (!o.enabled || !config.allowed_provider_regions.includes(o.region)) return null;
  const token = secret(o.secret_name);
  if (!token) throw new FatalExtractionError(`OCR is enabled but the secret ${o.secret_name} is not set`);
  return paddleOcrProvider(o, token);
}

const MAX_ATTEMPTS = 5;

/** User-facing text for a failed job (no stack traces, no keys). */
function failureMessage(e: unknown): string {
  if (e instanceof ResidencyError) return 'No AI provider is allowed for this data by the data-residency setting.';
  if (e instanceof FatalExtractionError) return e.message;
  if (e instanceof LlmError) {
    return e.kind === 'fatal'
      ? 'The extraction service is not set up correctly.'
      : 'The extraction service is unavailable.';
  }
  return 'Extraction failed.';
}

/**
 * Claims and runs jobs until `budgetMs` is used: the given document only, or any due job.
 * Returns what happened, for the response body.
 */
export async function runExtraction(db: Db, opts: { documentId?: string; budgetMs?: number; config?: AiConfig } = {}) {
  const config = opts.config ?? aiConfig;
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 110_000);
  const secret = (n: string) => Deno.env.get(n);
  const io = supabaseExtractionIO(db);
  const ran: { document_id: string; result: string }[] = [];

  while (Date.now() < deadline - 10_000) {
    const claimed = check(await db.rpc('claim_extraction_job', { did: opts.documentId ?? null })) as unknown[] | null;
    const row = claimed?.[0] as (Job & { status: string }) | undefined;
    if (!row) break;
    const job: Job = {
      document_id: row.document_id,
      project_id: row.project_id,
      step: row.step,
      cursor: row.cursor ?? {},
      attempts: row.attempts,
    };
    const router = createRouter({
      config,
      secret,
      log: async (c) => {
        await db.from('extraction_calls').insert({
          document_id: job.document_id,
          project_id: job.project_id,
          task: c.task,
          provider: c.provider,
          model: c.model,
          prompt_version: c.promptVersion,
          input_tokens: c.inputTokens,
          output_tokens: c.outputTokens,
          estimated_cost_usd: c.estimatedCostUsd,
          latency_ms: c.latencyMs,
          outcome: c.outcome,
          error: c.error ?? null,
        });
      },
    });

    let result: string;
    try {
      const out = await runJob(job, { io, router, config, ocr: ocrFromConfig(config, secret), deadline });
      if (out.state === 'done') {
        check(
          await db.from('extraction_jobs').update({
            status: 'done',
            step: 'done',
            locked_until: null,
            last_error: null,
          }).eq('document_id', job.document_id),
        );
        result = 'done';
      } else if (out.state === 'yield') {
        check(
          await db.from('extraction_jobs').update({
            status: 'pending',
            run_after: new Date().toISOString(),
            locked_until: null,
          }).eq('document_id', job.document_id),
        );
        result = 'yield';
      } else {
        check(
          await db.from('extraction_jobs').update({
            status: out.quota ? 'waiting_quota' : 'pending',
            run_after: out.runAfter.toISOString(),
            locked_until: null,
          }).eq('document_id', job.document_id),
        );
        if (out.quota) {
          await db.from('contract_documents').update({ extraction_step: 'waiting_quota' }).eq('id', job.document_id);
        }
        result = out.quota ? 'waiting_quota' : 'waiting';
      }
    } catch (e) {
      console.error(`extract-contract ${job.document_id} step ${job.step}:`, e);
      const attempts = job.attempts + 1;
      const fatal = isFatal(e) || attempts >= MAX_ATTEMPTS;
      check(
        await db.from('extraction_jobs').update({
          status: fatal ? 'failed' : 'pending',
          attempts,
          run_after: new Date(Date.now() + 30_000 * 2 ** (attempts - 1)).toISOString(),
          locked_until: null,
          last_error: String(e instanceof Error ? e.message : e).slice(0, 500),
        }).eq('document_id', job.document_id),
      );
      if (fatal) {
        check(
          await db.from('contract_documents').update({
            extraction_status: 'failed',
            extraction_step: null,
            error: failureMessage(e),
          }).eq('id', job.document_id),
        );
      }
      result = fatal ? 'failed' : 'retry';
    }
    ran.push({ document_id: job.document_id, result });
    // Work left on a yielded job: hand it to a fresh invocation (pg_net) rather than looping on.
    if (result === 'yield') {
      await db.rpc('kick_extraction', { did: job.document_id }).then(() => {}, () => {});
      break;
    }
    if (opts.documentId) break;
  }
  return { ran };
}

// The offline reference run (`--model oracle:reference`): a SCRIPTED stand-in for a model, not a
// model. It answers from the fixture's golden file, plus the deliberate mistakes in oracle.json
// (an invention with a real excerpt the guard can't catch, one with a made-up excerpt the guard
// must drop, a wrong value, a low-confidence value). It exists so the harness, the scoring and
// the pipeline (hard filter, guard, merging, rules) can be tested end to end without API keys.
// Its numbers say nothing about any real model.

import { encodeField, fieldKeysOf } from '../_shared/extraction/tasks.ts';
import type { GenerateRequest, GenerateResult, LlmProvider } from '../_shared/llm/provider.ts';
import { LlmError } from '../_shared/llm/provider.ts';
import type { OcrJobStatus, OcrProvider } from '../_shared/ocr/provider.ts';
import type { Fixture } from './fixtures.ts';

export const ORACLE_PROVIDER = 'oracle';
export const ORACLE_MODEL = 'reference';

function slipped(fx: Fixture, page: number, text: string): string {
  let out = text;
  for (const s of fx.oracle.ocr_slips ?? []) if (s.page === page) out = out.replaceAll(s.from, s.to);
  return out;
}

/** `ocr`: the scanned pages were read by the scripted OCR, so excerpts carry its slips. */
export function oracleProvider(fx: Fixture, opts: { ocr: boolean }): LlmProvider {
  const excerpt = (page: number, e: string) => (fx.expected.scanned && opts.ocr ? slipped(fx, page, e) : e);
  return {
    id: ORACLE_PROVIDER,
    generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const sent = new Set([...req.input.matchAll(/\[Page (\d+)/g)].map((m) => Number(m[1])));
      let data: unknown;
      if (req.schemaName === 'page_sections') {
        data = { pages: [...sent].map((n) => ({ page_no: n, section: fx.expected.sections[String(n)] ?? 'other' })) };
      } else if (req.schemaName === 'contract_fields') {
        const keys = fieldKeysOf(req.jsonSchema);
        const fields: unknown[] = [];
        for (const k of keys) {
          const scripted = fx.oracle.answers[k];
          const golden = fx.expected.fields[k];
          const a = scripted ??
            (golden ? { value: golden.value, page: golden.page, excerpt: golden.excerpt, confidence: 0.95 } : null);
          fields.push(encodeField(
            k,
            a && a.value !== null && sent.has(a.page)
              ? {
                value: a.value,
                page_no: a.page,
                source_excerpt: excerpt(a.page, a.excerpt),
                confidence: a.confidence,
              }
              : { value: null, page_no: null, source_excerpt: null, confidence: 0.9 },
          ));
        }
        data = { fields };
      } else if (req.schemaName === 'contract_amendments') {
        data = {
          amendments: fx.expected.amendments.filter((a) => sent.has(a.page)).map((a) => ({
            group_key: a.group_key,
            clause: a.clause,
            summary: a.summary,
            period: a.period,
            unit: a.unit,
            page_no: a.page,
            source_excerpt: excerpt(a.page, a.excerpt),
            confidence: 0.9,
          })),
        };
      } else if (req.schemaName === 'project_procedures') {
        data = {
          procedures: fx.expected.procedures.filter((p) => sent.has(p.page)).map((p) => ({
            kind: p.kind,
            summary: p.summary,
            period: p.period,
            unit: p.unit,
            page_no: p.page,
            source_excerpt: excerpt(p.page, p.excerpt),
            confidence: 0.9,
          })),
        };
      } else {
        return Promise.reject(new LlmError('fatal', `oracle: unknown schema ${req.schemaName}`, ORACLE_PROVIDER));
      }
      const parsed = req.schema.safeParse(data);
      if (!parsed.success) return Promise.reject(new LlmError('validation', parsed.error.message, ORACLE_PROVIDER));
      return Promise.resolve({
        data: parsed.data,
        usage: {
          inputTokens: Math.ceil((req.system.length + req.input.length) / 4),
          outputTokens: Math.ceil(JSON.stringify(data).length / 4),
        },
        raw: data,
      });
    },
  };
}

/** Scripted OCR: returns the fixture's source text for the page (with oracle.json's OCR slips). */
export function oracleOcr(fx: Fixture): OcrProvider {
  return {
    id: 'oracle_ocr',
    submit(file) {
      const m = /page-(\d+)\.pdf$/.exec(file.filename);
      return Promise.resolve(`oracle-${m ? m[1] : '1'}`);
    },
    poll(jobId): Promise<OcrJobStatus> {
      const page = Number(jobId.split('-')[1]);
      const text = fx.pages[page - 1];
      if (text === undefined) return Promise.resolve({ state: 'failed', error: `no page ${page}` });
      return Promise.resolve({ state: 'done', text: slipped(fx, page, text), confidence: null });
    },
  };
}

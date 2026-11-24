// PaddleOCR official API (AI Studio), document parsing. Wire format taken from the official
// SDK, @paddleocr/api-sdk 0.2.3 (dist/index.js), not guessed:
//   POST {base}/api/v2/ocr/jobs          multipart: file, model, optionalPayload (JSON string)
//                                        -> { code: 0, data: { jobId } }
//   GET  {base}/api/v2/ocr/jobs/{jobId}  -> { code: 0, data: { state: pending|running|done|failed,
//                                                              resultUrl: { jsonUrl }, errorMsg } }
//   GET  {jsonUrl} (no auth)             -> JSONL; each line { result: { layoutParsingResults:
//                                                              [{ markdown: { text } }] } }
//   Auth: Authorization: Bearer <AI Studio access token>
// Base URL, model and secret name come from aiConfig.ocr.

import type { OcrEntry } from '../llm/config-schema.ts';
import { OcrError, type OcrJobStatus, type OcrProvider } from './provider.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export function paddleOcrProvider(cfg: OcrEntry, token: string, f: typeof fetch = fetch): OcrProvider {
  const jobsUrl = `${cfg.base_url.replace(/\/+$/, '')}/api/v2/ocr/jobs`;

  async function call(url: string, init: RequestInit, auth: boolean): Promise<Response> {
    let res: Response;
    try {
      res = await f(url, {
        ...init,
        headers: { ...(init.headers ?? {}), ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new OcrError(`OCR request failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new OcrError(`OCR HTTP ${res.status}: ${text}`, res.status === 429 || res.status >= 500, res.status);
    }
    return res;
  }

  async function data(res: Response): Promise<Any> {
    const payload: Any = await res.json().catch(() => null);
    if (!payload || typeof payload !== 'object') throw new OcrError('OCR response was not JSON', true);
    if (payload.code !== undefined && payload.code !== 0) {
      throw new OcrError(`OCR API error ${payload.code}: ${payload.msg ?? 'unknown'}`, false);
    }
    return payload.data;
  }

  return {
    id: cfg.provider,
    async submit({ bytes, filename }) {
      const form = new FormData();
      form.append('model', cfg.model);
      form.append('optionalPayload', JSON.stringify({}));
      form.append('file', new Blob([bytes as BlobPart]), filename);
      const d = await data(await call(jobsUrl, { method: 'POST', body: form }, true));
      if (!d || typeof d.jobId !== 'string' || !d.jobId) throw new OcrError('OCR submit response has no jobId', false);
      return d.jobId;
    },
    async poll(jobId): Promise<OcrJobStatus> {
      const d = await data(await call(`${jobsUrl}/${encodeURIComponent(jobId)}`, { method: 'GET' }, true));
      const state = d?.state;
      if (state === 'pending' || state === 'running') return { state };
      if (state === 'failed') return { state, error: typeof d.errorMsg === 'string' ? d.errorMsg : 'OCR job failed' };
      if (state !== 'done') throw new OcrError(`Unknown OCR job state: ${state}`, false);
      const jsonUrl = d.resultUrl?.jsonUrl;
      if (typeof jsonUrl !== 'string') throw new OcrError('Done OCR job has no resultUrl.jsonUrl', false);
      const body = await (await call(jsonUrl, { method: 'GET' }, false)).text();
      const pages: string[] = [];
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        const obj: Any = JSON.parse(line);
        for (const r of obj?.result?.layoutParsingResults ?? []) {
          if (typeof r?.markdown?.text === 'string') pages.push(r.markdown.text);
        }
      }
      // One page was submitted; join defensively if the provider split it.
      return { state: 'done', text: markdownToText(pages.join('\n\n')), confidence: null };
    },
  };
}

/** Markdown -> plain text good enough for excerpt matching (tables keep their cell text). */
export function markdownToText(md: string): string {
  return md
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

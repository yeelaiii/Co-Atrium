// In-memory ExtractionIO, a scripted LLM provider and a PDF builder for the pipeline tests.

import { PDFDocument, StandardFonts } from 'pdf-lib';

import type { DocumentInfo, ExtractionIO, Job, PageRow, RuleRow } from '../../_shared/server/extraction.ts';
import type { GenerateRequest, GenerateResult, LlmProvider } from '../../_shared/llm/provider.ts';
import { LlmError } from '../../_shared/llm/provider.ts';
import { encodeField, fieldKeysOf, type LibraryPeriodRow } from '../../_shared/extraction/tasks.ts';
import type { OcrProvider } from '../../_shared/ocr/provider.ts';

/** A PDF whose pages carry the given text ('' = a page with no text layer, like a scan). */
export async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    let y = 800;
    for (const line of text.split('\n')) {
      if (line) page.drawText(line, { x: 40, y, size: 11, font });
      y -= 16;
    }
  }
  return await doc.save();
}

export class MemoryIO implements ExtractionIO {
  files = new Map<string, Uint8Array>();
  docs = new Map<
    string,
    DocumentInfo & { page_count?: number; pages_estimated?: boolean; extraction_step?: string | null }
  >();
  pageRows = new Map<string, PageRow[]>();
  rules: RuleRow[] = [];
  library: (LibraryPeriodRow & { applies_to_contract_forms: string[] })[] = [];
  ocrUsed = 0;
  ocrQuotaLeft = Infinity;
  saved: Job[] = [];
  results: { fields: any[]; rules: any[]; findings: any[]; warnings: string[] } | null = null;
  downloads = 0;

  addDocument(doc: DocumentInfo, bytes: Uint8Array) {
    this.docs.set(doc.id, { ...doc });
    this.files.set(doc.storage_path, bytes);
  }
  document(id: string) {
    return Promise.resolve(this.docs.get(id)!);
  }
  download(path: string) {
    this.downloads++;
    return Promise.resolve(this.files.get(path)!);
  }
  pages(id: string) {
    return Promise.resolve((this.pageRows.get(id) ?? []).map((p) => ({ ...p })));
  }
  upsertPages(doc: DocumentInfo, rows: PageRow[]) {
    const byNo = new Map((this.pageRows.get(doc.id) ?? []).map((p) => [p.page_no, p]));
    for (const r of rows) byNo.set(r.page_no, { ...r });
    this.pageRows.set(doc.id, [...byNo.values()].sort((a, b) => a.page_no - b.page_no));
    return Promise.resolve();
  }
  setDocument(id: string, patch: Record<string, unknown>) {
    Object.assign(this.docs.get(id)!, patch);
    return Promise.resolve();
  }
  saveCursor(job: Job) {
    this.saved.push(structuredClone(job));
    return Promise.resolve();
  }
  reserveOcr(_p: string, _d: string, wanted: number, _q: number) {
    const granted = Math.max(0, Math.min(wanted, this.ocrQuotaLeft));
    this.ocrQuotaLeft -= granted;
    this.ocrUsed += granted;
    return Promise.resolve(granted);
  }
  projectRules() {
    return Promise.resolve(this.rules);
  }
  libraryPeriods(form: string) {
    return Promise.resolve(
      this.library.filter((r) => r.applies_to_contract_forms.includes(form) && r.period_field !== null),
    );
  }
  writeResults(
    _doc: DocumentInfo,
    out: { fields: unknown[]; rules: unknown[]; findings: unknown[]; warnings: string[] },
  ) {
    this.results = structuredClone(out) as any;
    return Promise.resolve();
  }
}

export interface ScriptedCall {
  provider: string;
  schemaName: string;
  input: string;
  fieldKeys: string[];
}

export type Truth = Record<string, { value: unknown; page: number; excerpt: string; confidence?: number }>;

/**
 * A provider that answers like a careful model: fields from `truth` when their page was sent,
 * otherwise null; sections from the page marker text; amendments / procedures as scripted.
 */
export function scriptedProvider(
  id: string,
  calls: ScriptedCall[],
  opts: {
    truth?: Truth;
    amendments?: unknown[];
    procedures?: unknown[];
    sections?: Record<number, string>;
    /** Throw this for these schema names. */
    fail?: Partial<Record<string, () => LlmError>>;
  },
): LlmProvider {
  return {
    id,
    generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const fieldKeys = fieldKeysOf(req.jsonSchema);
      calls.push({ provider: id, schemaName: req.schemaName, input: req.input, fieldKeys });
      const failing = opts.fail?.[req.schemaName];
      if (failing) return Promise.reject(failing());
      const sent = new Set([...req.input.matchAll(/\[Page (\d+)/g)].map((m) => Number(m[1])));
      let data: unknown;
      if (req.schemaName === 'page_sections') {
        data = { pages: [...sent].map((n) => ({ page_no: n, section: opts.sections?.[n] ?? 'other' })) };
      } else if (req.schemaName === 'contract_fields') {
        const fields: unknown[] = [];
        for (const k of fieldKeys) {
          const t = opts.truth?.[k];
          fields.push(encodeField(
            k,
            t && sent.has(t.page)
              ? { value: t.value, page_no: t.page, source_excerpt: t.excerpt, confidence: t.confidence ?? 0.95 }
              : { value: null, page_no: null, source_excerpt: null, confidence: 0.9 },
          ));
        }
        data = { fields };
      } else if (req.schemaName === 'contract_amendments') {
        data = { amendments: (opts.amendments ?? []).filter((a: any) => sent.has(a.page_no)) };
      } else if (req.schemaName === 'project_procedures') {
        data = { procedures: (opts.procedures ?? []).filter((p: any) => sent.has(p.page_no)) };
      }
      const parsed = req.schema.safeParse(data);
      if (!parsed.success) return Promise.reject(new LlmError('validation', parsed.error.message, id));
      return Promise.resolve({
        data: parsed.data,
        usage: { inputTokens: Math.ceil(req.input.length / 4), outputTokens: 50 },
        raw: data,
      });
    },
  };
}

export class FakeOcr implements OcrProvider {
  id = 'paddleocr_api';
  submitted: { filename: string; size: number }[] = [];
  polls = 0;
  constructor(private text: string, private pendingPolls = 1) {}
  submit(file: { bytes: Uint8Array; filename: string }) {
    this.submitted.push({ filename: file.filename, size: file.bytes.length });
    return Promise.resolve(`job-${this.submitted.length}`);
  }
  poll() {
    this.polls++;
    if (this.polls <= this.pendingPolls) return Promise.resolve({ state: 'running' as const });
    return Promise.resolve({ state: 'done' as const, text: this.text, confidence: null });
  }
}

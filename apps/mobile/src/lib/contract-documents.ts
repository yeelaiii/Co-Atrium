// Contract documents: pick, upload (with progress) to the private 'contract-documents' bucket,
// register for extraction, and read back proposals. Server side: migration 0024 and the
// extract-contract Edge Function.

import * as DocumentPicker from 'expo-document-picker';
import { File, UploadType } from 'expo-file-system';

import { supabase } from '@/lib/supabase';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export const DOCUMENT_MIME = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const;
export type DocumentMime = keyof typeof DOCUMENT_MIME;

export type ExtractionStatus = 'queued' | 'processing' | 'needs_review' | 'complete' | 'failed';

export type ContractDocument = {
  id: string;
  project_id: string;
  storage_path: string;
  filename: string;
  mime: DocumentMime;
  size_bytes: number;
  page_count: number | null;
  pages_estimated: boolean;
  extraction_status: ExtractionStatus;
  extraction_step: string | null;
  warnings: string[];
  error: string | null;
  uploaded_by: string | null;
  created_at: string;
};

export type NotFoundReason = 'not_found' | 'excerpt_not_in_source' | 'invalid_value' | 'extraction_failed';

export type ExtractedField = {
  id: string;
  project_id: string;
  document_id: string;
  field_key: string;
  value: unknown;
  page_no: number | null;
  source_excerpt: string | null;
  confidence: number;
  not_found_reason: NotFoundReason | null;
  status: 'proposed' | 'confirmed' | 'rejected' | 'superseded' | 'no_change';
  edited_value: unknown;
  provider: string | null;
  model: string | null;
  created_at: string;
};

export type ExtractionFinding = {
  id: string;
  document_id: string;
  kind: 'amendment' | 'procedure' | 'suspected_invention';
  summary: string;
  clause: string | null;
  page_no: number | null;
  source_excerpt: string | null;
  confidence: number | null;
  status: 'open' | 'dismissed';
};

export const STEP_LABEL: Record<string, string> = {
  text: 'Reading text',
  ocr: 'Reading scanned pages',
  classify: 'Finding sections',
  identify: 'Identifying the contract form',
  fields: 'Extracting values',
  amendments: 'Checking particular conditions',
  procedures: 'Checking preliminaries',
  write: 'Saving',
  waiting_quota: 'Waiting for tomorrow’s scanning quota',
};

export const NOT_FOUND_LABEL: Record<NotFoundReason, string> = {
  not_found: 'Not found in the document',
  excerpt_not_in_source: 'Dropped: the cited words are not on that page',
  invalid_value: 'Could not be read reliably',
  extraction_failed: 'Could not be extracted',
};

export type PickedDocument = { uri: string; name: string; mimeType: DocumentMime; size: number };

/** Opens the system picker for PDFs, Word (.docx) and images. Oversized or unsupported files are returned in `rejected`. */
export async function pickDocuments(): Promise<{ picked: PickedDocument[]; rejected: string[] }> {
  const res = await DocumentPicker.getDocumentAsync({
    type: Object.keys(DOCUMENT_MIME),
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return { picked: [], rejected: [] };
  const picked: PickedDocument[] = [];
  const rejected: string[] = [];
  for (const a of res.assets) {
    const mime = (a.mimeType ?? mimeFromName(a.name)) as DocumentMime | null;
    const size = a.size ?? new File(a.uri).size ?? 0;
    if (!mime || !(mime in DOCUMENT_MIME)) rejected.push(`${a.name}: use PDF, Word (.docx), JPEG or PNG`);
    else if (size > MAX_DOCUMENT_BYTES) rejected.push(`${a.name}: larger than 50 MB`);
    else picked.push({ uri: a.uri, name: a.name, mimeType: mime, size });
  }
  return { picked, rejected };
}

function mimeFromName(name: string): DocumentMime | null {
  const ext = name.split('.').pop()?.toLowerCase();
  const hit = Object.entries(DOCUMENT_MIME).find(([, e]) => e === ext || (ext === 'jpeg' && e === 'jpg'));
  return (hit?.[0] as DocumentMime | undefined) ?? null;
}

function uuid(): string {
  // RFC 4122 v4 from Math.random: only used as an unguessable-enough object name; access is by RLS.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export type UploadHandle = { promise: Promise<string>; cancel: () => void };

/**
 * Uploads one file straight to Storage (binary body, so progress is real), registers it and
 * starts extraction. Resolves to the new document id.
 */
export function uploadContractDocument(projectId: string, doc: PickedDocument, onProgress: (fraction: number) => void): UploadHandle {
  const controller = new AbortController();
  const promise = (async () => {
    const { data: s } = await supabase.auth.getSession();
    const token = s.session?.access_token;
    if (!token) throw new Error('Not signed in');
    const path = `${projectId}/${uuid()}.${DOCUMENT_MIME[doc.mimeType]}`;
    const url = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/contract-documents/${path}`;
    const task = new File(doc.uri).createUploadTask(url, {
      httpMethod: 'POST',
      uploadType: UploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
        'Content-Type': doc.mimeType,
        'x-upsert': 'false',
        'cache-control': '3600',
      },
      signal: controller.signal,
      onProgress: ({ bytesSent, totalBytes }) => totalBytes > 0 && onProgress(Math.min(1, bytesSent / totalBytes)),
    });
    const res = await task.uploadAsync();
    if (res.status < 200 || res.status >= 300) {
      let message = `Upload failed (${res.status})`;
      try {
        message = JSON.parse(res.body).message ?? message;
      } catch {
        // keep the status
      }
      throw new Error(message);
    }
    onProgress(1);
    const { data: did, error } = await supabase.rpc('register_contract_document', {
      pid: projectId,
      path,
      fname: doc.name.slice(0, 200),
      file_mime: doc.mimeType,
    });
    if (error) throw error;
    startExtraction(did as string);
    return did as string;
  })();
  return { promise, cancel: () => controller.abort() };
}

/** Asks the server to start now (pg_net and the 1-minute cron also pick it up). Not awaited. */
export function startExtraction(documentId: string) {
  supabase.functions.invoke('extract-contract', { body: { document_id: documentId } }).catch(() => {});
}

export async function retryDocument(documentId: string) {
  const { error } = await supabase.rpc('retry_contract_document', { did: documentId });
  if (!error) startExtraction(documentId);
  return error;
}

/** Short-lived signed URL for viewing a document (storage policy: owners and members). */
export async function documentUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('contract-documents').createSignedUrl(path, 300);
  return data?.signedUrl ?? null;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function documentErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '42501') return err.message || 'You do not have permission to do that.';
  if (err?.code && ['22023', 'P0002', '54000', '23505'].includes(err.code)) return err.message ?? 'That could not be done.';
  if (err instanceof Error && err.message) return err.message;
  return 'That could not be done. Check your connection and try again.';
}
